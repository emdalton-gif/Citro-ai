// api/customer-portal.js
// Creates a Stripe Customer Portal session so subscribers can manage
// their subscription, update payment method, or cancel.
// Called from sub-dashboard.html with a Bearer token.

const crypto = require('crypto');
const https  = require('https');
const querystring = require('querystring');

// ── JWT verification ─────────────────────────────────────────────────────────

function verifyToken(token) {
  try {
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString());
    const { p: payload, s: sig } = decoded;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (sig !== expected) return null;
    const [, email, exp] = payload.split(':');
    if (Date.now() > Number(exp)) return null;
    return email;
  } catch (e) {
    return null;
  }
}

// ── Upstash helpers ──────────────────────────────────────────────────────────

async function upstashCmd(cmd) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  return res.json();
}

async function upstashGet(key) {
  const r = await upstashCmd(['GET', key]);
  return r.result ? JSON.parse(r.result) : null;
}

// ── Stripe POST ──────────────────────────────────────────────────────────────

function stripePost(path, params) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(params);
    const options = {
      hostname: 'api.stripe.com',
      path: `/v1${path}`,
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid Stripe response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  // Auth
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  const email = verifyToken(token);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Get subscriber record to find Stripe customer ID
    const subscriber = await upstashGet(`subscriber:${email}`);
    if (!subscriber) return res.status(404).json({ error: 'Subscriber not found' });

    const customerId = subscriber.stripeCustomerId;
    if (!customerId) {
      return res.status(400).json({ error: 'No billing account found. Please contact support@getcitro.ai' });
    }

    // Create Stripe Customer Portal session
    const origin = req.headers.origin || 'https://getcitro.ai';
    const portalSession = await stripePost('/billing_portal/sessions', {
      customer:   customerId,
      return_url: `${origin}/sub-dashboard.html`,
    });

    if (portalSession.error) {
      return res.status(400).json({ error: portalSession.error.message });
    }

    return res.json({ url: portalSession.url });

  } catch (err) {
    console.error('customer-portal error:', err.message);
    res.status(500).json({ error: 'Could not open billing portal' });
  }
};
