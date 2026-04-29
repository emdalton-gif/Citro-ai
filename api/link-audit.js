// api/link-audit.js
// Associates an existing audit result with an authenticated customer account.
// Called after register or login from the post-audit screen.

const crypto = require('crypto');

function verifyCustomerToken(token) {
  if (!token) return null;
  try {
    const { p: payload, s: sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const parts = payload.split(':');
    if (parts[0] !== 'customer') return null;
    if (Date.now() > parseInt(parts[parts.length - 1], 10)) return null;
    return parts.slice(1, -1).join(':'); // email
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
  const email = verifyCustomerToken(token);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  const { resultId } = req.body;
  if (!resultId) return res.status(400).json({ error: 'Missing resultId' });

  try {
    // Fetch audit metadata
    const audit = await upstashGet(`audit:${resultId}`);
    if (!audit) return res.status(404).json({ error: 'Audit not found' });

    // Get current audit list for this customer
    const existing = await upstashGet(`customer-audits:${email}`) || [];

    // Skip if already linked
    if (existing.some(a => a.resultId === resultId)) {
      return res.json({ ok: true });
    }

    // Prepend new record
    existing.unshift({
      resultId,
      companyName: audit.orderData?.company_name || 'Unknown',
      industry: audit.orderData?.industry || '',
      score: audit.score || 0,
      plan: audit.orderData?.plan || 'snapshot',
      costEstimate: audit.costEstimate || null,
      createdAt: audit.createdAt || Date.now(),
    });

    await upstashSet(`customer-audits:${email}`, existing);
    res.json({ ok: true });
  } catch (err) {
    console.error('link-audit error:', err.message);
    res.status(500).json({ error: 'Could not link audit' });
  }
};
