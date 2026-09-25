// api/free-check.js
// The free, no-card Citro check. Public; the top of the self-serve funnel.
//
// Unlike the retired quick-check (a model *guessing* whether AI would name a
// brand), this is a real measurement on a small scale: three buyer questions,
// each sent to ChatGPT and Google Gemini with web search on, exactly as the
// paid audit does it (api/live-query.js). The visitor sees what those two
// assistants actually said, who they named instead, and which sites they read.
// The paid product adds the other three platforms, their own editable
// questions and personas, several markets, history and the 90-day plan.
//
// Cost per check is a few cents: 1 question-writing call, 6 web-search
// answers, 1 grading call. Guarded by per-IP and per-domain daily limits and
// a global daily ceiling (FREE_CHECK_DAILY_CAP, default 150).
//
// Env: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_AI_API_KEY (already set),
//      UPSTASH_REDIS_REST_URL/TOKEN (limits + lead storage; skipped if absent),
//      RESEND_API_KEY + LEAD_NOTIFY_EMAIL (optional: email each new lead to you).

const https = require('https');
const crypto = require('crypto');
const { CALLERS, parseLocation, NEAR_ME_RE, NO_LOCATION_PLATFORMS } = require('./live-query.js');

const PLATFORMS = ['ChatGPT', 'Google Gemini'];
const QUESTIONS = 3;
const IP_DAILY_CAP = 3;
const DOMAIN_DAILY_CAP = 3;
const GLOBAL_DAILY_CAP = parseInt(process.env.FREE_CHECK_DAILY_CAP || '150', 10);
const DAY = 86400;
const ANSWER_TIMEOUT_MS = 70000;
const WRITER_MODEL = 'claude-sonnet-4-6';

// ── Upstash ───────────────────────────────────────────────────────────────────
const upstashOn = () => !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
async function upstash(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}
async function incrWithTtl(key, ttl) {
  const r = await upstash(['INCR', key]);
  const n = typeof r?.result === 'number' ? r.result : 1;
  if (n === 1) { try { await upstash(['EXPIRE', key, ttl]); } catch {} }
  return n;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizeDomain(raw) {
  try {
    let u = String(raw || '').trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const h = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    return /\.[a-z]{2,}$/.test(h) ? h : null;
  } catch { return null; }
}
const validEmail = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim()) && e.length < 200;
const today = () => new Date().toISOString().slice(0, 10);
const clean = (s, n = 200) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function parseJsonLoose(raw) {
  const s = String(raw || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/[\[{][\s\S]*[\]}]/);
  if (m) return JSON.parse(m[0]);
  throw new Error('Could not parse model output');
}

async function claude(prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const body = JSON.stringify({ model: WRITER_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', timeout: 40000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (res.statusCode !== 200) return reject(new Error(`Anthropic ${res.statusCode}`));
          resolve((j.content || []).map(b => b.text || '').join(''));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

// Best-effort read of the homepage so the questions fit what the business
// actually sells. Short timeout; never blocks the check.
async function siteContext(domain) {
  const strip = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  const grab = (html, re) => { const m = html.match(re); return m ? strip(m[1]) : ''; };
  for (const url of [`https://${domain}/`, `https://www.${domain}/`]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'CitroBot/1.0 (+https://getcitro.ai)', Accept: 'text/html' } });
      clearTimeout(timer);
      if (!r.ok || !/text\/html/i.test(r.headers.get('content-type') || '')) continue;
      const html = (await r.text()).slice(0, 150000);
      const parts = [
        ['Page title', grab(html, /<title[^>]*>([\s\S]*?)<\/title>/i)],
        ['Site name', grab(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)],
        ['Description', grab(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)],
        ['Main heading', grab(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)],
      ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
      if (parts.length) return parts.join('\n').slice(0, 900);
    } catch {}
  }
  return null;
}

async function writeQuestions({ domain, company, offer, loc, ctx }) {
  const local = loc && loc.region ? loc.label : '';
  const prompt = `You are writing buyer questions for a small AI search visibility check. Each question will be sent to ChatGPT and Google Gemini, and we check whether the business below is recommended in the answer.

Website: ${domain}
${company ? `Business name (from the visitor): ${company}\n` : ''}${offer ? `What they sell (from the visitor): ${offer}\n` : ''}${ctx ? `Read from their homepage:\n"""\n${ctx}\n"""\n` : ''}Where their buyers search from: ${local || 'anywhere in the US'}

1. Identify the business name and, in plain buyer language, the category of what it sells (what a customer would call it). Trust what the visitor typed over the homepage.
2. Write exactly ${QUESTIONS} short questions (5 to 12 words) that a real buyer types into ChatGPT when choosing a provider in that category, so that a good answer lists specific businesses or products:
   - #1: the best or top options in the category${local ? ', ending with "near me"' : ''}.
   - #2: a request for providers in the category with one qualifier (budget, size, format, need).
   - #3: a buyer describing the problem this business solves and asking who to use.
   Never name the business. No "how to", research or trend questions. Stay squarely in its category.

Return ONLY JSON: {"company":"...","category":"...","questions":["...","...","..."]}`;
  const j = parseJsonLoose(await claude(prompt, 600));
  const qs = (j.questions || []).map(q => clean(q, 160)).filter(Boolean).slice(0, QUESTIONS);
  if (qs.length < QUESTIONS) throw new Error('question writing failed');
  return { company: clean(j.company || company || domain, 80), category: clean(j.category || offer, 120), questions: qs };
}

async function grade(company, domain, answers) {
  const list = answers.map((a, i) => `### Answer ${i}\nQuestion: ${a.question}\nAssistant: ${a.platform}\n"""\n${a.text.slice(0, 5000)}\n"""`).join('\n\n');
  const prompt = `For each AI answer below, decide whether it recommends or names the business "${company}" (website ${domain}; a mention of that website also counts as the business).

For each answer return:
- named: true or false
- rank: its position among the businesses named (1 = first), or null
- visibility: "high" if rank 1 or 2 with substantive coverage; "medium" if rank 3-4, or rank 1-2 with only a name-drop; "low" if rank 5+ or incidental; "none" if not named
- instead: up to 3 businesses or products the answer recommends that a buyer could choose instead (not ${company}; not review sites, directories, associations or government bodies)

${list}

Return ONLY JSON: [{"i":0,"named":true,"rank":1,"visibility":"high","instead":["..."]}, ...]`;
  const j = parseJsonLoose(await claude(prompt, 1200));
  return Array.isArray(j) ? j : [];
}

async function answerOnce(platform, question, loc) {
  let sent = question;
  if (NO_LOCATION_PLATFORMS.has(platform) && loc && loc.region) sent = sent.replace(NEAR_ME_RE, `near ${loc.label}`);
  const r = await CALLERS[platform](sent, loc, ANSWER_TIMEOUT_MS);
  if (!r.text) throw new Error('empty answer');
  return { text: r.text, sources: r.sources || [], sent };
}

const WEIGHTS = { high: 1, medium: 0.5, low: 0.25, none: 0 };

function notifyLead(lead) {
  const key = process.env.RESEND_API_KEY, to = process.env.LEAD_NOTIFY_EMAIL;
  if (!key || !to) return Promise.resolve();
  const html = `<p><b>New free check:</b> ${lead.company} (${lead.domain})</p>
<p>Email: ${lead.email}<br>Location: ${lead.location || 'All of the US'}<br>Category: ${lead.category || ''}</p>
<p>Named in ${lead.named} of ${lead.answered} answers. Score ${lead.score}%.</p>
<p>Top competitors: ${(lead.competitors || []).join(', ') || 'none'}</p>`;
  const payload = JSON.stringify({ from: 'Citro <audit@getcitro.ai>', to: [to], subject: `Free check: ${lead.company} (${lead.score}%)`, html });
  return new Promise(resolve => {
    const req = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST', timeout: 8000,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, () => resolve());
    req.on('error', () => resolve()); req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(payload); req.end();
  });
}

function sendResultsEmail(to, r) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return Promise.resolve();
  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const link = `https://getcitro.ai/free-check.html?id=${r.id}`;
  const trial = `https://getcitro.ai/start.html?em=${encodeURIComponent(to)}&co=${encodeURIComponent(r.company)}&url=${encodeURIComponent(r.domain)}`;
  const color = r.score >= 65 ? '#026F8B' : r.score >= 35 ? '#C97A12' : '#E8452A';
  const comp = r.competitors.slice(0, 3).map(c => esc(c.name)).join(', ');
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F2F8FA;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:540px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #D7E7ED;">
<div style="background:#07202B;padding:24px 32px;"><span style="font-size:20px;font-weight:800;color:#00BDE7;">Citro</span></div>
<div style="padding:32px;">
<p style="font-size:20px;font-weight:700;color:#07202B;margin:0 0 8px;">Your free AI visibility check: ${esc(r.company)}</p>
<p style="font-size:14px;color:#48626E;margin:0 0 20px;">Quick Citro Score: <strong style="color:${color};font-size:18px;">${r.score}%</strong> &middot; named in ${r.named} of ${r.answered} answers on ChatGPT and Google Gemini.</p>
${comp ? `<p style="font-size:15px;color:#48626E;line-height:1.6;margin:0 0 20px;">Recommended instead: <strong style="color:#07202B;">${comp}</strong>.</p>` : ''}
<a href="${link}" style="display:inline-block;background:#00BDE7;color:#04222E;padding:12px 22px;border-radius:999px;font-size:14px;font-weight:700;text-decoration:none;margin-bottom:24px;">See your full results</a>
<p style="font-size:14px;color:#48626E;line-height:1.6;margin:0 0 8px;">This check asked 3 questions on 2 assistants. The full Citro audit runs your customers' real questions on all five major AI assistants and gives your team a 90-day plan.</p>
<p style="margin:0 0 24px;"><a href="${trial}" style="color:#026F8B;font-weight:600;">Start a 7-day free trial</a></p>
<p style="font-size:12px;color:#7E959F;line-height:1.6;margin:0;">You're receiving this because you ran a free check at getcitro.ai. Questions? Reply to this email.</p>
</div></div></body></html>`;
  const payload = JSON.stringify({ from: 'Citro <audit@getcitro.ai>', to: [to], subject: `Does AI recommend ${r.company}? Your free check`, html });
  return new Promise(resolve => {
    const req = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST', timeout: 8000,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, () => resolve());
    req.on('error', () => resolve()); req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(payload); req.end();
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  // GET ?id= returns a saved result (for the link in follow-up emails).
  if (req.method === 'GET') {
    const id = String(req.query?.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
    if (!id || !upstashOn()) { res.status(404).json({ ok: false }); return; }
    try {
      const r = await upstash(['GET', `fc:result:${id}`]);
      if (!r?.result) { res.status(404).json({ ok: false }); return; }
      const { email, ...pub } = JSON.parse(r.result);
      res.status(200).json(pub);
    } catch { res.status(404).json({ ok: false }); }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  const b = req.body || {};
  // Honeypot: real visitors never see or fill this field.
  if (b.company_fax) { res.status(200).json({ ok: false, reason: 'rejected', message: 'Something went wrong. Please try again.' }); return; }
  const domain = normalizeDomain(b.website);
  if (!domain) { res.status(400).json({ ok: false, message: 'Please enter your website, for example yourcompany.com.' }); return; }
  if (!validEmail(b.email)) { res.status(400).json({ ok: false, message: 'Please enter a valid email so we can send your results.' }); return; }
  const email = b.email.trim().toLowerCase();
  const company = clean(b.company, 80);
  const offer = clean(b.offer, 160);
  const locText = clean(b.location, 80);
  const loc = locText ? parseLocation(locText) : parseLocation('');
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  if (upstashOn()) {
    try {
      const d = today();
      if (await incrWithTtl(`fc:all:${d}`, DAY) > GLOBAL_DAILY_CAP) {
        try { await upstash(['LPUSH', 'fc:queued', JSON.stringify({ email, domain, company, offer, location: locText, ts: Date.now() })]); } catch {}
        res.status(200).json({ ok: false, reason: 'capacity', message: "We're running a lot of checks today. We've saved your request and will email your results shortly." });
        return;
      }
      if (await incrWithTtl(`fc:ip:${d}:${ip}`, DAY) > IP_DAILY_CAP) {
        res.status(200).json({ ok: false, reason: 'limit', message: "You've run the free check a few times today. Start a free trial to audit on all five platforms with your own questions." });
        return;
      }
      if (await incrWithTtl(`fc:dom:${d}:${domain}`, DAY) > DOMAIN_DAILY_CAP) {
        res.status(200).json({ ok: false, reason: 'limit', message: 'This website has been checked a few times today. Start a free trial for the full audit.' });
        return;
      }
    } catch { /* never block a visitor on a limiter error */ }
  }

  try {
    const ctx = await siteContext(domain);
    const w = await writeQuestions({ domain, company, offer, loc: loc && loc.region ? loc : null, ctx });

    const jobs = [];
    w.questions.forEach((question, qi) => PLATFORMS.forEach(platform => jobs.push({ qi, question, platform })));
    const settled = await Promise.allSettled(jobs.map(j => answerOnce(j.platform, j.question, loc)));
    const answers = jobs.map((j, k) => settled[k].status === 'fulfilled'
      ? { ...j, ok: true, ...settled[k].value }
      : { ...j, ok: false, error: String(settled[k].reason?.message || settled[k].reason || 'failed') });
    const answered = answers.filter(a => a.ok);
    if (!answered.length) throw new Error('no platform answered');

    const verdicts = await grade(w.company, domain, answered);
    answered.forEach((a, i) => {
      const v = verdicts.find(x => Number(x.i) === i) || {};
      a.named = v.named === true;
      a.rank = Number.isFinite(v.rank) ? v.rank : null;
      a.visibility = WEIGHTS[v.visibility] !== undefined ? v.visibility : (a.named ? 'medium' : 'none');
      if (a.rank && a.rank > 2 && a.visibility === 'high') a.visibility = 'medium';
      if (a.rank && a.rank > 4 && a.visibility === 'medium') a.visibility = 'low';
      const own = [w.company.toLowerCase(), domain];
      a.instead = (Array.isArray(v.instead) ? v.instead : []).map(x => clean(x, 60)).filter(x => x && !own.includes(x.toLowerCase())).slice(0, 3);
      a.cited_own_site = a.sources.some(s => { const d = String(s.domain || '').toLowerCase(); return d === domain || d.endsWith('.' + domain); });
    });

    const score = Math.round(answered.reduce((s, a) => s + WEIGHTS[a.visibility], 0) / answered.length * 100);
    const named = answered.filter(a => a.named).length;
    const tally = (arr) => { const c = {}; arr.forEach(x => { c[x] = (c[x] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1]); };
    const competitors = tally(answered.flatMap(a => a.instead)).slice(0, 5).map(([name, n]) => ({ name, n }));
    const sources = tally(answered.flatMap(a => [...new Set(a.sources.map(s => String(s.domain || '').toLowerCase()).filter(Boolean))])).slice(0, 6).map(([domain, n]) => ({ domain, n }));
    const ownSiteUsed = answered.filter(a => a.cited_own_site).length;

    const result = {
      ok: true,
      id: crypto.randomBytes(9).toString('base64url'),
      company: w.company, category: w.category, domain,
      location: loc && loc.region ? loc.label : 'United States',
      platforms: PLATFORMS,
      score, named, answered: answered.length, total: answers.length,
      competitors, sources, ownSiteUsed,
      questions: w.questions.map((q, qi) => ({
        question: q,
        results: answers.filter(a => a.qi === qi).map(a => a.ok
          ? { platform: a.platform, ok: true, named: a.named, rank: a.rank, visibility: a.visibility, instead: a.instead,
              excerpt: a.text.replace(/\s+/g, ' ').slice(0, 420), sources: a.sources.slice(0, 4).map(s => s.domain || s.title || ''),
              cited_own_site: a.cited_own_site, sent: a.sent !== q ? a.sent : null }
          : { platform: a.platform, ok: false }),
      })),
      createdAt: Date.now(),
    };

    if (upstashOn()) {
      const lead = { email, domain, company: w.company, category: w.category, location: locText, score, named, answered: answered.length,
                     competitors: competitors.map(c => c.name), ts: result.createdAt, id: result.id, source: 'free-check' };
      try {
        await Promise.all([
          upstash(['SET', `fc:result:${result.id}`, JSON.stringify({ ...result, email }), 'EX', 60 * 60 * 24 * 90]),
          upstash(['LPUSH', 'fc:leads', JSON.stringify(lead)]),
          upstash(['SET', `lead:${email}`, JSON.stringify(lead), 'EX', 60 * 60 * 24 * 90]),
        ]);
      } catch {}
      await Promise.all([
        notifyLead({ ...lead, answered: answered.length }).catch(() => {}),
        sendResultsEmail(email, result).catch(() => {}),
      ]);
    }

    res.status(200).json(result);
  } catch (err) {
    console.error('free-check error:', err.message);
    res.status(200).json({ ok: false, reason: 'failed', message: "We couldn't finish your check just now. Please try again in a minute." });
  }
};
