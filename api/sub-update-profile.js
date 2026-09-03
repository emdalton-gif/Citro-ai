// api/sub-update-profile.js
// Updates account-level profile fields for a subscriber.
// Currently: company_name (the dashboard heading). Personas, runs, properties
// and the Stripe record are untouched.
//
// Email is NOT editable here. It is the primary key for subscriber:*,
// subscriber-profile:*, subscriber-runs:* and subscriber-properties:*, and it
// keys the Stripe customer, so changing it is a migration rather than a field
// edit. Subscribers are routed to support instead.

const crypto = require('crypto');

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const email = verifySubscriberToken(token);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  const { companyName } = req.body || {};
  if (typeof companyName !== 'string') {
    return res.status(400).json({ error: 'Missing companyName' });
  }

  const newName = companyName.trim().replace(/\s+/g, ' ');
  if (!newName) return res.status(400).json({ error: 'Company name cannot be empty' });
  if (newName.length > 60) return res.status(400).json({ error: 'Company name must be 60 characters or fewer' });
  if (/[<>]/.test(newName)) return res.status(400).json({ error: 'Company name cannot contain < or >' });

  try {
    const account = await upstashGet(`subscriber:${email}`);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const profile = (await upstashGet(`subscriber-profile:${email}`)) || {};
    profile.company_name = newName;
    // Marks the name as deliberately chosen, so the dashboard stops second-guessing
    // it against property names.
    profile.company_name_set = true;
    await upstashSet(`subscriber-profile:${email}`, profile);

    res.json({ companyName: newName });
  } catch (err) {
    console.error('sub-update-profile error:', err.message);
    res.status(500).json({ error: 'Could not update your account' });
  }
};
