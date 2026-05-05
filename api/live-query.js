// api/live-query.js
// Sends queries to real AI platform APIs (Perplexity, OpenAI) and returns live responses.
// Requires a valid subscriber or portal token.
//
// Required environment variables:
//   PERPLEXITY_API_KEY  — from https://www.perplexity.ai/settings/api
//   OPENAI_API_KEY      — from https://platform.openai.com/api-keys

const https = require('https');
const crypto = require('crypto');

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

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
      timeout: 30000,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('Invalid JSON from upstream: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(bodyStr);
    req.end();
  });
}

// ── Platform callers ──────────────────────────────────────────────────────────

async function callPerplexity(query) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not configured in Vercel environment');

  const result = await httpsPost('api.perplexity.ai', '/chat/completions', {
    'Authorization': `Bearer ${apiKey}`,
  }, {
    model: 'sonar-pro',
    messages: [{ role: 'user', content: query }],
    max_tokens: 700,
  });

  if (result.status !== 200) {
    throw new Error(`Perplexity API ${result.status}: ${JSON.stringify(result.body?.error || result.body)}`);
  }
  return result.body.choices?.[0]?.message?.content || '';
}

async function callOpenAI(query) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured in Vercel environment');

  const result = await httpsPost('api.openai.com', '/v1/chat/completions', {
    'Authorization': `Bearer ${apiKey}`,
  }, {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: query }],
    max_tokens: 700,
  });

  if (result.status !== 200) {
    throw new Error(`OpenAI API ${result.status}: ${JSON.stringify(result.body?.error || result.body)}`);
  }
  return result.body.choices?.[0]?.message?.content || '';
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const isAuthed = verifySubscriberToken(token) || verifyPortalToken(token);
  if (!isAuthed) return res.status(401).json({ error: 'Unauthorized' });

  const { query, platform } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });
  if (!platform) return res.status(400).json({ error: 'Missing platform' });

  try {
    let response = '';
    if (platform === 'Perplexity') {
      response = await callPerplexity(query);
    } else if (platform === 'ChatGPT') {
      response = await callOpenAI(query);
    } else {
      return res.status(400).json({ error: `Live queries not supported for ${platform}` });
    }
    res.json({ response, is_live: true, platform });
  } catch (err) {
    console.error(`live-query error [${platform}]:`, err.message);
    res.status(500).json({ error: err.message });
  }
};
