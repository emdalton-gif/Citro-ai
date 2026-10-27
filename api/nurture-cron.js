// api/nurture-cron.js
// Runs daily (see "crons" in vercel.json). Sends every follow-up email that is
// due. Vercel calls cron routes with "Authorization: Bearer $CRON_SECRET" when
// CRON_SECRET is set, and with a vercel-cron user agent either way.

const N = require('./_lib/nurture');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = req.headers['authorization'] || '';
  const secret = process.env.CRON_SECRET;
  const fromVercel = /vercel-cron/i.test(req.headers['user-agent'] || '');
  if (secret ? auth !== `Bearer ${secret}` : !fromVercel) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (!process.env.UPSTASH_REDIS_REST_URL) { res.status(500).json({ error: 'Storage is not configured' }); return; }
  if (!process.env.NURTURE_POSTAL_ADDRESS) {
    console.error('nurture: NURTURE_POSTAL_ADDRESS is not set, so no follow-up emails were sent');
    res.status(200).json({ ok: false, reason: 'NURTURE_POSTAL_ADDRESS is not set' });
    return;
  }
  const now = Date.now();
  const due = await N.upstash(['ZRANGEBYSCORE', 'nurture:due', 0, now, 'LIMIT', 0, 50]);
  const emails = Array.isArray(due.result) ? due.result : [];
  const results = {};
  for (const e of emails) {
    try { const r = await N.sendDue(e, now); results[r] = (results[r] || 0) + 1; }
    catch (err) { console.error('nurture send error', err.message); results.error = (results.error || 0) + 1; }
  }
  console.log('nurture cron', JSON.stringify({ due: emails.length, ...results }));
  res.status(200).json({ ok: true, due: emails.length, ...results });
};
