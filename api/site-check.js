// api/site-check.js
// POST { website, brand } -> { ok, facts }
// Reads the customer's site (llms.txt, robots.txt rules for AI crawlers,
// sitemap and page inventory, schema.org markup on sample pages, Wikidata) so
// report recommendations are grounded in what the site actually has.
// Requires a subscriber, portal or purchase token, same as live-query.

const crypto = require('crypto');
const { checkSite } = require('./_lib/site-facts');

function verify(token, kind) {
  if (!token) return null;
  try {
    const { p: payload, s: sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const parts = payload.split(':');
    if (kind === 'subscriber') {
      if (parts[0] !== 'subscriber' || Date.now() > parseInt(parts[parts.length - 1], 10)) return null;
      return parts.slice(1, -1).join(':');
    }
    if (kind === 'purchase') {
      if (parts[0] !== 'purchase' || Date.now() > parseInt(parts[2], 10)) return null;
      return parts[1];
    }
    // portal: username:exp
    if (parts[0] === 'subscriber' || parts[0] === 'purchase') return null;
    if (Date.now() > parseInt(parts[1], 10)) return null;
    return parts[0];
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!(verify(token, 'subscriber') || verify(token, 'portal') || verify(token, 'purchase'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { website, brand } = req.body || {};
  if (!website) return res.status(400).json({ error: 'Missing website' });

  try {
    const out = await checkSite(String(website).slice(0, 300), brand ? String(brand).slice(0, 120) : '');
    res.status(out.ok ? 200 : 400).json(out);
  } catch (e) {
    console.error('site-check failed', e);
    res.status(500).json({ ok: false, error: 'Site check failed' });
  }
};
