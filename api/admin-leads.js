// api/admin-leads.js
// Free-check leads for the admin, newest first. Each completed free check is
// pushed to the Redis list fc:leads by api/free-check.js; checks that hit the
// daily capacity are queued on fc:queued and listed separately.
// Requires a valid admin token (from api/admin-auth.js) in Authorization.

const crypto = require('crypto');

function verifyAdminToken(token) {
  if (!token) return false;
  try {
    const { p: payload, s: sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
    const parts = payload.split(':');
    if (parts.length !== 2 || parts[0] !== 'admin') return false;
    return Date.now() <= parseInt(parts[1], 10);
  } catch { return false; }
}

async function upstash(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}

const parse = list => (Array.isArray(list) ? list : []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const auth = req.headers['authorization'] || '';
  if (!verifyAdminToken(auth.startsWith('Bearer ') ? auth.slice(7) : null)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (!process.env.UPSTASH_REDIS_REST_URL) { res.status(500).json({ error: 'Lead storage is not configured' }); return; }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '200', 10) || 200));
  try {
    const [done, queued] = await Promise.all([
      upstash(['LRANGE', 'fc:leads', 0, limit - 1]),
      upstash(['LRANGE', 'fc:queued', 0, limit - 1]),
    ]);
    const leads = parse(done.result);
    res.status(200).json({
      leads,
      queued: parse(queued.result),
      notify: { resend: !!process.env.RESEND_API_KEY, to: !!process.env.LEAD_NOTIFY_EMAIL },
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not read leads' });
  }
};
