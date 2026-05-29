// api/sub-register.js
// Creates a subscriber account after a successful subscription checkout.
// Stores email + hashed password + Stripe IDs in Upstash Redis.
// Issues a 30-day subscriber session token on success.

const crypto = require('crypto');

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

  const { email, password, stripeCustomerId, stripeSubscriptionId, profile, plan } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const normalized = email.toLowerCase().trim();

  try {
    const existing = await upstashGet(`subscriber:${normalized}`);
    if (existing) {
      // Account exists — update subscription IDs and save profile if provided
      const updated = {
        ...existing,
        stripeCustomerId: stripeCustomerId || existing.stripeCustomerId,
        stripeSubscriptionId: stripeSubscriptionId || existing.stripeSubscriptionId,
        subscriptionStatus: 'active',
        plan: plan || existing.plan,
        updatedAt: Date.now(),
      };
      const saves = [upstashSet(`subscriber:${normalized}`, updated)];
      if (profile) {
        saves.push(upstashSet(`subscriber-profile:${normalized}`, { ...profile, updatedAt: Date.now() }));
      }
      await Promise.all(saves);
      const token = issueSubscriberToken(normalized);
      return res.json({ token, email: normalized });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(password, salt);

    // Save subscriber account
    await upstashSet(`subscriber:${normalized}`, {
      email: normalized,
      passwordHash,
      salt,
      plan: plan || 'professional',
      stripeCustomerId: stripeCustomerId || null,
      stripeSubscriptionId: stripeSubscriptionId || null,
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
