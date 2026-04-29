// api/save-results.js
// Saves completed audit results to Upstash Redis.
// Returns a resultId the buyer can use to revisit their audit.

const crypto = require('crypto');

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

async function upstashSet(key, value, ttlSeconds) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SET', key, JSON.stringify(value), 'EX', ttlSeconds]),
  });
  return res.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const sessionId = verifyPurchaseToken(token);

  if (!sessionId) return res.status(401).json({ error: 'Unauthorized' });

  const { results, report, orderData, score, costEstimate, tokenUsage } = req.body;
  if (!results) return res.status(400).json({ error: 'Missing results' });

  const resultId = crypto.randomBytes(16).toString('hex');
  const ttl = 90 * 24 * 60 * 60; // 90 days

  try {
    await upstashSet(`audit:${resultId}`, {
      resultId,
      sessionId,
      results,
      report,
      orderData,
      score,
      costEstimate: costEstimate || null,
      tokenUsage: tokenUsage || null,
      createdAt: Date.now(),
    }, ttl);

    res.json({ resultId });
  } catch (err) {
    console.error('save-results error:', err.message);
    res.status(500).json({ error: 'Could not save results' });
  }
};
