// api/unsubscribe.js
// The link at the bottom of every follow-up email. GET shows a confirmation
// page; POST is the one-click unsubscribe mail apps send (RFC 8058).

const N = require('./_lib/nurture');

const page = (title, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} | Citro</title>
<style>body{margin:0;background:#F7FBFC;color:#07202B;font-family:Inter,system-ui,sans-serif}main{max-width:480px;margin:80px auto;padding:0 20px}h1{font-size:24px;margin:0 0 12px}p{color:#48626E;line-height:1.6}a{color:#026F8B}</style></head>
<body><main><p style="font-weight:800;color:#00BDE7;font-size:20px;margin-bottom:32px">Citro</p><h1>${title}</h1>${body}</main></body></html>`;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const email = N.norm(q.e);
  if (!email || !N.validToken(email, q.t)) {
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page('That link didn\'t work', '<p>This unsubscribe link is incomplete or has expired. Reply to any of our emails and we\'ll remove you by hand.</p>'));
    return;
  }
  try { await N.unsubscribe(email); } catch (e) { console.error('unsubscribe failed', e.message); }
  if (req.method === 'POST') { res.status(200).json({ ok: true }); return; }
  res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page('You\'re unsubscribed', '<p>You won\'t get any more follow-up emails from Citro. If that was a mistake, reply to any earlier email and we\'ll add you back.</p>'));
};
