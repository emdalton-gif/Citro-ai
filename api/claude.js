// api/claude.js — Vercel Serverless Function
// Proxies authenticated requests to the Anthropic Messages API.
//
// Required environment variables (set in Vercel dashboard):
//   ANTHROPIC_API_KEY — your Anthropic key
//   JWT_SECRET        — same secret as used in api/auth.js

const https = require('https');
const crypto = require('crypto');

// ── Token verification ───────────────────────────────────────────────────────

// Verifies a portal login token (username:exp)
function verifyToken(token) {
  if (!token) return null;
  try {
    const { p: payload, s: sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const [username, exp] = payload.split(':');
    if (Date.now() > parseInt(exp, 10)) return null;
    return username;
  } catch {
    return null;
  }
}

// Verifies a self-serve purchase token (purchase:sessionId:exp)
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
  } catch {
    return null;
  }
}

// Verifies a subscriber session token (subscriber:email:exp)
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
    return parts.slice(1, -1).join(':'); // email
  } catch {
    return null;
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // ── Auth gate — accepts portal, purchase, OR subscriber tokens ──
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const username = verifyToken(token);
  const purchaseSessionId = username ? null : verifyPurchaseToken(token);
  const subscriberEmail = (username || purchaseSessionId) ? null : verifySubscriberToken(token);

  if (!username && !purchaseSessionId && !subscriberEmail) {
    res.status(401).json({ error: 'Unauthorized. Please log in or complete your purchase.' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server configuration error: missing API key.' });
    return;
  }

  // ── Forward to Anthropic ───────────────────────────────────────────────────
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

  const opts = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  };

  const proxy = https.request(opts, (anthropicRes) => {
    res.writeHead(anthropicRes.statusCode, { 'Content-Type': 'application/json' });
    anthropicRes.pipe(res);
  });

  proxy.on('error', (err) => {
    console.error('Anthropic proxy error:', err.message);
    res.status(502).json({ error: 'Upstream API error: ' + err.message });
  });

  proxy.write(body);
  proxy.end();
};
