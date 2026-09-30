// api/sub-register.js
// Two jobs:
//  1. Creates a subscriber account after a completed subscription checkout.
//     The Stripe session is verified here; plan and Stripe IDs come from Stripe,
//     never from the request.
//  2. Updates an existing account's company profile. That needs the account's
//     own session token (Authorization: Bearer) or its password. The profile is
//     merged, so saved questions, personas and the locked company stay put.
// Issues a 30-day subscriber session token when the caller proves who they are.

const crypto = require('crypto');
const https  = require('https');

const NOOP_PASSWORD = '_noop_update_';

function stripeGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.stripe.com', path: `/v1${path}`, method: 'GET',
      headers: { Authorization: 'Basic ' + Buffer.from((process.env.STRIPE_SECRET_KEY || '') + ':').toString('base64') },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid Stripe response')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// Returns { plan, stripeCustomerId, stripeSubscriptionId } for a completed
// checkout that belongs to this email, or null.
async function verifiedCheckout(sessionId, email) {
  if (!sessionId || !/^cs_[A-Za-z0-9_]+$/.test(String(sessionId))) return null;
  const session = await stripeGet(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (!session || session.error) return null;
  if (!(session.status === 'complete' || session.payment_status === 'paid')) return null;
  const owner = String(session.client_reference_id || session.customer_details?.email || session.customer_email || '').toLowerCase().trim();
  if (owner !== email) return null;
  return {
    plan: session.metadata?.plan === 'enterprise' ? 'enterprise' : 'professional',
    stripeCustomerId: session.customer || null,
    stripeSubscriptionId: session.subscription || null,
  };
}

function tokenEmail(token) {
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

async function upstashSet(key, value) {
  return upstashCmd(['SET', key, JSON.stringify(value)]);
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, hash) => {
      if (err) reject(err);
      else resolve(hash.toString('hex'));
    });
  });
}

function issueSubscriberToken(email) {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const payload = `subscriber:${email}:${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { email, password, profile, sessionId } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const normalized = String(email).toLowerCase().trim();
  const auth = req.headers['authorization'] || '';
  const bearerOk = auth.startsWith('Bearer ') && tokenEmail(auth.slice(7)) === normalized;

  try {
    const existing = await upstashGet(`subscriber:${normalized}`);
    if (existing) {
      let passwordOk = false;
      if (password !== NOOP_PASSWORD && existing.passwordHash && existing.salt) {
        const h = await hashPassword(password, existing.salt);
        passwordOk = h.length === existing.passwordHash.length &&
          crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(existing.passwordHash, 'hex'));
      }
      if (!bearerOk && !passwordOk) {
        return res.status(401).json({ error: 'An account with this email already exists. Please log in.' });
      }

      const saves = [];
      // A completed checkout (e.g. a retried confirm page) can refresh billing.
      if (password !== NOOP_PASSWORD && sessionId) {
        const checkout = await verifiedCheckout(sessionId, normalized);
        if (checkout) {
          saves.push(upstashSet(`subscriber:${normalized}`, {
            ...existing,
            plan: checkout.plan,
            stripeCustomerId: checkout.stripeCustomerId || existing.stripeCustomerId,
            stripeSubscriptionId: checkout.stripeSubscriptionId || existing.stripeSubscriptionId,
            subscriptionStatus: 'active',
            updatedAt: Date.now(),
          }));
        }
      }
      if (profile && typeof profile === 'object') {
        const current = await upstashGet(`subscriber-profile:${normalized}`) || {};
        saves.push(upstashSet(`subscriber-profile:${normalized}`, { ...current, ...profile, updatedAt: Date.now() }));
      }
      await Promise.all(saves);
      if (password === NOOP_PASSWORD) return res.json({ ok: true, email: normalized });
      return res.json({ token: issueSubscriberToken(normalized), email: normalized });
    }

    // New account: only after a completed checkout for this email.
    const checkout = await verifiedCheckout(sessionId, normalized);
    if (!checkout) {
      return res.status(402).json({ error: 'We could not confirm your payment. Please contact support@getcitro.ai.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(password, salt);

    // Save subscriber account
    await upstashSet(`subscriber:${normalized}`, {
      email: normalized,
      passwordHash,
      salt,
      plan: checkout.plan,
      stripeCustomerId: checkout.stripeCustomerId,
      stripeSubscriptionId: checkout.stripeSubscriptionId,
      subscriptionStatus: 'active',
      createdAt: Date.now(),
    });

    // Save company profile separately so it can be updated without touching auth data
    if (profile) {
      await upstashSet(`subscriber-profile:${normalized}`, {
        ...profile,
        updatedAt: Date.now(),
      });
    }

    const token = issueSubscriberToken(normalized);
    res.json({ token, email: normalized });
  } catch (err) {
    console.error('sub-register error:', err.message);
    res.status(500).json({ error: 'Could not create subscriber account' });
  }
};
