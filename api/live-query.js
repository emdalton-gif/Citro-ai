// api/live-query.js
// Sends one buyer question to one AI platform and returns the answer the way a
// new, anonymous buyer would get it: web search on, no personalization.
// Accepts purchase tokens (one-time Snapshot buyers), subscriber tokens, and portal tokens.
//
// Methodology (see the Citro methodology doc):
//   1. API only. Never a logged-in consumer account, so no memory, chat
//      history or custom instructions can colour the answer.
//   2. The buyer's question is sent word for word. No system prompt, persona
//      or history goes to the answering platform.
//   3. Web search is on for every platform, because every consumer app now
//      searches before answering "which X should I buy" questions. Answering
//      from model memory alone systematically missed specialist brands.
//   4. Location comes only from the property's "where your buyers are
//      searching from" setting, never from the operator. Blank means all of
//      the US. Platforms whose API has no location option answer nationally,
//      and the response says so.
//   5. Models match what a free consumer user of each app gets. Every model ID
//      can be overridden with an environment variable (below) so a retirement
//      is a settings change, not a code deploy.
//
// Required environment variables:
//   PERPLEXITY_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY, XAI_API_KEY
// Optional model overrides:
//   CITRO_MODEL_CHATGPT, CITRO_MODEL_CLAUDE, CITRO_MODEL_GEMINI, CITRO_MODEL_GROK, CITRO_PERPLEXITY_PRESET

const https = require('https');
const crypto = require('crypto');

// Models checked against provider docs on 2026-09-23.
const MODELS = {
  ChatGPT:        process.env.CITRO_MODEL_CHATGPT     || 'gpt-5.6-luna',     // ChatGPT Free default
  Claude:         process.env.CITRO_MODEL_CLAUDE      || 'claude-sonnet-5',
  'Google Gemini': process.env.CITRO_MODEL_GEMINI     || 'gemini-3.8-flash',
  Grok:           process.env.CITRO_MODEL_GROK        || 'grok-4.7',
  Perplexity:     process.env.CITRO_PERPLEXITY_PRESET || 'low',              // Agent API preset; sonar-pro's successor
};

const MAX_OUTPUT_TOKENS = 1500;
// Vercel maxDuration for this function is 120s (vercel.json). Leave headroom
// for one retry of a fast failure; a slow answer gets one long attempt.
const CALL_TIMEOUT_MS = 95000;
const TOTAL_BUDGET_MS = 110000;

// ── Token verification ────────────────────────────────────────────────────────

function verifySubscriberToken(token) {
  if (!token) return null;
  try {
    const { p: payload, s: sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const parts = payload.split(':');
    if (parts[0] !== 'subscriber') return null;
    if (Date.now() > parseInt(parts[parts.length - 1], 10)) return null;
    return parts.slice(1, -1).join(':');
  } catch { return null; }
}

function verifyPortalToken(token) {
  if (!token) return null;
  try {
    const { p: payload, s: sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const [username, exp] = payload.split(':');
    if (Date.now() > parseInt(exp, 10)) return null;
    return username;
  } catch { return null; }
}

function verifyPurchaseToken(token) {
  if (!token) return null;
  try {
    const { p: payload, s: sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const parts = payload.split(':');
    if (parts[0] !== 'purchase') return null;
    if (Date.now() > parseInt(parts[2], 10)) return null;
    return parts[1]; // sessionId
  } catch { return null; }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpsPost(hostname, path, headers, body, timeoutMs = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); }
        catch { return reject(Object.assign(new Error('Invalid JSON from upstream: ' + data.slice(0, 200)), { status: res.statusCode })); }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error('Request timed out'), { timeout: true })); });
    req.write(bodyStr);
    req.end();
  });
}

function apiError(name, result) {
  const b = result.body || {};
  const detail = b.error?.message || b.error || b.message || b.detail || b;
  const err = new Error(`${name} API ${result.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`);
  err.status = result.status;
  return err;
}

// ── Location ──────────────────────────────────────────────────────────────────
// The property's geography field is free text ("Grand Rapids, MI",
// "US only", "Northeast"). Only a clearly identified US place is passed;
// anything ambiguous answers nationally rather than guessing.

const US_STATES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',
  FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',
  LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',
  MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',
  NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',
  RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',
  VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia',
};
const STATE_BY_NAME = Object.fromEntries(Object.entries(US_STATES).map(([k, v]) => [v.toLowerCase(), v]));

function parseLocation(geo) {
  const raw = String(geo || '').trim();
  // Blank means all of the US: Citro's market is US buyers, and leaving the
  // country unset let each provider pick its own default.
  if (!raw) return { country: 'US', label: 'United States' };
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const last = (parts[parts.length - 1] || '').replace(/\./g, '');
  const stateFromLast = US_STATES[last.toUpperCase()] || STATE_BY_NAME[last.toLowerCase()];
  if (stateFromLast) {
    const city = parts.length > 1 ? parts[0] : undefined;
    return { country: 'US', region: stateFromLast, ...(city ? { city } : {}), label: city ? `${city}, ${stateFromLast}` : stateFromLast };
  }
  const whole = STATE_BY_NAME[raw.toLowerCase()];
  if (whole) return { country: 'US', region: whole, label: whole };
  if (/^(us|usa|u\.s\.a?\.?|united states)( only)?$/i.test(raw) || /\b(nationwide|national)\b/i.test(raw)) {
    return { country: 'US', label: 'United States' };
  }
  return null;
}

// ── Response helpers ──────────────────────────────────────────────────────────

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function addSource(list, url, title) {
  if (!url || typeof url !== 'string') return;
  if (list.some(s => s.url === url)) return;
  list.push({ url, title: title ? String(title).slice(0, 200) : '', domain: hostOf(url) });
}

// Responses-API shape shared by OpenAI and xAI: output[] with message items
// whose content[] holds output_text parts with url_citation annotations.
function parseResponsesShape(body) {
  const sources = [];
  const texts = [];
  const queries = [];
  for (const item of body.output || []) {
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if ((part.type === 'output_text' || part.type === 'text') && part.text) {
          texts.push(part.text);
          for (const a of part.annotations || []) {
            if (a.type === 'url_citation') addSource(sources, a.url, typeof a.title === 'string' && !/^\d+$/.test(a.title) ? a.title : '');
          }
        }
      }
    } else if (item.type === 'web_search_call') {
      if (item.action?.query) queries.push(item.action.query);
      for (const s of item.action?.sources || []) addSource(sources, s.url, s.title);
    }
  }
  if (!texts.length && typeof body.output_text === 'string') texts.push(body.output_text);
  for (const c of body.citations || []) addSource(sources, typeof c === 'string' ? c : c?.url, c?.title);
  return { text: texts.join('\n\n').trim(), sources, searchQueries: queries };
}

// ── Platform callers ──────────────────────────────────────────────────────────
// Each returns { text, sources:[{url,title,domain}], searchQueries, model, locationApplied }.

async function callOpenAI(query, loc, timeoutMs) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  const tool = { type: 'web_search' };
  if (loc) tool.user_location = { type: 'approximate', country: loc.country, ...(loc.region ? { region: loc.region } : {}), ...(loc.city ? { city: loc.city } : {}) };
  const result = await httpsPost('api.openai.com', '/v1/responses', { Authorization: `Bearer ${apiKey}` }, {
    model: MODELS.ChatGPT,
    input: query,
    tools: [tool],
    include: ['web_search_call.action.sources'],
    reasoning: { effort: 'low' },
    max_output_tokens: MAX_OUTPUT_TOKENS,
  }, timeoutMs);
  if (result.status !== 200) throw apiError('OpenAI', result);
  return { ...parseResponsesShape(result.body), model: MODELS.ChatGPT, locationApplied: !!loc };
}

async function callClaude(query, loc, timeoutMs) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
  if (loc) tool.user_location = { type: 'approximate', country: loc.country, ...(loc.region ? { region: loc.region } : {}), ...(loc.city ? { city: loc.city } : {}) };
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const base = { model: MODELS.Claude, max_tokens: MAX_OUTPUT_TOKENS, tools: [tool] };
  let messages = [{ role: 'user', content: query }];
  const content = [];
  // A long search can pause mid-turn (stop_reason "pause_turn"); the docs say
  // to send the assistant turn back unchanged to let it finish.
  // Claude decides for itself whether to search, and the first live health
  // check showed it answering from memory (no search, no sources). Every
  // other platform searched. Requiring at least one search on the first turn
  // keeps the five platforms on the same footing. If the API ever rejects the
  // requirement, fall back to letting Claude choose rather than failing.
  let forceSearch = true;
  for (let turn = 0; turn < 3; turn++) {
    const payload = { ...base, messages, ...(turn === 0 && forceSearch ? { tool_choice: { type: 'any' } } : {}) };
    let result = await httpsPost('api.anthropic.com', '/v1/messages', headers, payload, timeoutMs);
    if (turn === 0 && forceSearch && result.status === 400 && /tool_choice/i.test(JSON.stringify(result.body))) {
      forceSearch = false;
      result = await httpsPost('api.anthropic.com', '/v1/messages', headers, { ...base, messages }, timeoutMs);
    }
    if (result.status !== 200) throw apiError('Anthropic', result);
    content.push(...(result.body.content || []));
    if (result.body.stop_reason !== 'pause_turn') break;
    messages = [{ role: 'user', content: query }, { role: 'assistant', content: result.body.content }];
  }
  const sources = [];
  const queries = [];
  // Text that precedes the last search call is the model narrating ("I'll
  // search for..."), not part of the answer a buyer reads.
  let lastToolIdx = -1;
  content.forEach((b, i) => { if (b.type === 'server_tool_use' || b.type === 'web_search_tool_result') lastToolIdx = i; });
  const texts = [];
  content.forEach((b, i) => {
    if (b.type === 'server_tool_use' && b.input?.query) queries.push(b.input.query);
    if (b.type === 'text' && i > lastToolIdx) {
      texts.push(b.text);
      for (const c of b.citations || []) addSource(sources, c.url, c.title);
    }
  });
  if (!texts.length) content.forEach(b => { if (b.type === 'text') texts.push(b.text); });
  // If the answer carried no inline citations, record the pages the search
  // returned: those are what the answer was written from.
  if (!sources.length) {
    content.forEach(b => {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        b.content.forEach(r => { if (r.type === 'web_search_result') addSource(sources, r.url, r.title); });
      }
    });
  }
  const errBlock = content.find(b => b.type === 'web_search_tool_result' && b.content?.type === 'web_search_tool_result_error');
  if (!texts.join('').trim() && errBlock) throw new Error(`Anthropic web search error: ${errBlock.content.error_code}`);
  return { text: texts.join('').trim(), sources, searchQueries: queries, model: MODELS.Claude, locationApplied: !!loc };
}

async function callGemini(query, loc, timeoutMs) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');
  const model = MODELS['Google Gemini'];
  const result = await httpsPost(
    'generativelanguage.googleapis.com',
    `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { 'x-goog-api-key': apiKey },
    {
      contents: [{ role: 'user', parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingLevel: 'low' } },
    },
    timeoutMs,
  );
  if (result.status !== 200) throw apiError('Gemini', result);
  const cand = result.body.candidates?.[0] || {};
  const text = (cand.content?.parts || []).map(p => p.text || '').join('').trim();
  const gm = cand.groundingMetadata || {};
  const sources = [];
  // Gemini returns redirect links (vertexaisearch...) with the site's domain
  // as the title, so the title is what identifies the source.
  for (const ch of gm.groundingChunks || []) {
    const w = ch.web || {};
    if (!w.uri) continue;
    const domain = /\./.test(w.title || '') && !/\s/.test(w.title) ? w.title.replace(/^www\./, '') : hostOf(w.uri);
    if (!sources.some(s => s.domain === domain && s.title === w.title)) sources.push({ url: w.uri, title: w.title || domain, domain });
  }
  return { text, sources, searchQueries: gm.webSearchQueries || [], model, locationApplied: false };
}

async function callGrok(query, loc, timeoutMs) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured');
  const result = await httpsPost('api.x.ai', '/v1/responses', { Authorization: `Bearer ${apiKey}` }, {
    model: MODELS.Grok,
    input: [{ role: 'user', content: query }],
    tools: [{ type: 'web_search' }],
    max_output_tokens: MAX_OUTPUT_TOKENS,
  }, timeoutMs);
  if (result.status !== 200) throw apiError('Grok', result);
  const parsed = parseResponsesShape(result.body);
  // Grok writes inline citation markers like [[1]](https://...) into the text.
  parsed.text = parsed.text.replace(/\s*\[\[\d+\]\]\([^)]+\)/g, '');
  return { ...parsed, model: MODELS.Grok, locationApplied: false };
}

async function callPerplexity(query, loc, timeoutMs) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not configured');
  const headers = { Authorization: `Bearer ${apiKey}` };
  const body = { preset: MODELS.Perplexity, input: query, max_output_tokens: MAX_OUTPUT_TOKENS };
  let locationApplied = false;
  let result;
  if (loc) {
    // Agent API (replaces Sonar, which Perplexity retires 2026-09-27). The
    // preset already searches; the explicit tool carries the location. If the
    // API rejects that combination, retry on the preset alone, still searched.
    const withLoc = { ...body, tools: [{ type: 'web_search', user_location: { country: loc.country, ...(loc.region ? { region: loc.region } : {}), ...(loc.city ? { city: loc.city } : {}) } }] };
    result = await httpsPost('api.perplexity.ai', '/v1/agent', headers, withLoc, timeoutMs);
    if (result.status === 200) locationApplied = true;
    else if (result.status !== 400 && result.status !== 422) throw apiError('Perplexity', result);
  }
  if (!result || result.status !== 200) {
    result = await httpsPost('api.perplexity.ai', '/v1/agent', headers, body, timeoutMs);
    if (result.status !== 200) throw apiError('Perplexity', result);
  }
  const out = result.body.output || [];
  const sources = [];
  const queries = [];
  for (const item of out) {
    if (item.type === 'search_results') {
      queries.push(...(item.queries || []));
      for (const r of item.results || []) addSource(sources, r.url, r.title);
    }
  }
  const parsed = parseResponsesShape(result.body);
  for (const s of parsed.sources) addSource(sources, s.url, s.title);
  return { text: parsed.text, sources, searchQueries: queries, model: result.body.model || `preset:${MODELS.Perplexity}`, locationApplied };
}

const NO_LOCATION_PLATFORMS = new Set(['Google Gemini', 'Grok']);
const NEAR_ME_RE = /\b(near me|nearby|close to me|in my area|around me)\b/i;

const CALLERS = {
  ChatGPT: callOpenAI,
  Claude: callClaude,
  'Google Gemini': callGemini,
  Grok: callGrok,
  Perplexity: callPerplexity,
};

// One retry for transient failures (rate limit, overload, fast network error)
// when there is time left. A timeout is not retried: it already used most of
// the budget, and a second slow call would hit the platform limit.
async function callWithRetry(platform, query, loc) {
  const started = Date.now();
  const fn = CALLERS[platform];
  try {
    return await fn(query, loc, CALL_TIMEOUT_MS);
  } catch (err) {
    const transient = err.status === 429 || (err.status >= 500 && err.status < 600) || (!err.status && !err.timeout);
    const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
    if (!transient || remaining < 20000) throw err;
    await new Promise(r => setTimeout(r, 1500));
    return await fn(query, loc, remaining - 2000);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const isAuthed = verifySubscriberToken(token) || verifyPortalToken(token) || verifyPurchaseToken(token);
  if (!isAuthed) return res.status(401).json({ error: 'Unauthorized' });

  const { query, platform, geo } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Missing query' });
  if (!platform) return res.status(400).json({ error: 'Missing platform' });
  if (!CALLERS[platform]) return res.status(400).json({ error: `Live queries not supported for ${platform}` });

  const loc = parseLocation(geo);
  const started = Date.now();
  // Gemini's and Grok's APIs can't take a location, but their apps answer
  // "near me" from the phone's location. Writing the property's location
  // into the question is the closest match. Only done for a real city or
  // state, only on those two platforms, and reported back as query_sent.
  let sent = String(query).slice(0, 500);
  if (NO_LOCATION_PLATFORMS.has(platform) && loc && loc.region) {
    sent = sent.replace(NEAR_ME_RE, `near ${loc.label}`);
  }
  try {
    const r = await callWithRetry(platform, sent, loc);
    if (!r.text) throw new Error(`${platform} returned an empty answer`);
    res.json({
      response: r.text,
      sources: r.sources.slice(0, 25),
      search_queries: r.searchQueries.slice(0, 10),
      web_search: true,
      model: r.model,
      location: (r.locationApplied || sent !== String(query).slice(0, 500)) && loc ? loc.label : null,
      query_sent: sent,
      latency_ms: Date.now() - started,
      is_live: true,
      platform,
    });
  } catch (err) {
    console.error(`live-query error [${platform}]:`, err.message);
    res.status(500).json({ error: err.message });
  }
};

module.exports.parseLocation = parseLocation;
module.exports.parseResponsesShape = parseResponsesShape;
module.exports.CALLERS = CALLERS;
module.exports.MODELS = MODELS;
module.exports._httpsPost = httpsPost;
