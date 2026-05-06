// api/sub-update-personas.js
// Saves edited buyer personas back to the subscriber's profile.
// Called from the "My Buyer Personas" section of the subscriber dashboard.

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

  const { personas } = req.body;

  // Validate: must be an array of 1–5 objects with at minimum a name or title
  if (!Array.isArray(personas) || personas.length === 0 || personas.length > 5) {
    return res.status(400).json({ error: 'personas must be an array of 1–5 items' });
  }
  for (const p of personas) {
    if (typeof p !== 'object' || (!p.name && !p.title)) {
      return res.status(400).json({ error: 'Each persona must have at least a name or title' });
    }
  }

  try {
    const profile = await upstashGet(`subscriber-profile:${email}`);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    await upstashSet(`subscriber-profile:${email}`, {
      ...profile,
      personas,
      personasUpdatedAt: Date.now(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('sub-update-personas error:', err.message);
    res.status(500).json({ error: 'Could not save personas' });
  }
};
