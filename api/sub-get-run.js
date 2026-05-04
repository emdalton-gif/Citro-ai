// api/sub-get-run.js
// Returns full results for a specific audit run. Subscriber must own the run.

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const email = verifySubscriberToken(token);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  const { runId } = req.query;
  if (!runId) return res.status(400).json({ error: 'Missing runId' });

  try {
    const run = await upstashGet(`subscriber-run:${runId}`);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.email !== email) return res.status(403).json({ error: 'Forbidden' });

    res.json(run);
  } catch (err) {
    console.error('sub-get-run error:', err.message);
    res.status(500).json({ error: 'Could not load run' });
  }
};
