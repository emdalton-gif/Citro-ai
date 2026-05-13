// api/sub-remove-property.js
// Removes a monitored property from an Enterprise subscriber's account.

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

  const { propertyId } = req.body;
  if (!propertyId) return res.status(400).json({ error: 'Missing propertyId' });

  try {
    const account = await upstashGet(`subscriber:${email}`);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.plan !== 'enterprise') {
      return res.status(403).json({ error: 'Enterprise plan required' });
    }

    const properties = await upstashGet(`subscriber-properties:${email}`) || [];
    const updated = properties.filter(p => p.id !== propertyId);

    if (updated.length === properties.length) {
      return res.status(404).json({ error: 'Property not found' });
    }

    await upstashSet(`subscriber-properties:${email}`, updated);
    res.json({ properties: updated });
  } catch (err) {
    console.error('sub-remove-property error:', err.message);
    res.status(500).json({ error: 'Could not remove property' });
  }
};
