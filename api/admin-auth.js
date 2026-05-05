// api/admin-auth.js
// Admin login — checks ADMIN_PASSWORD env var, issues a portal-style token.
// The token is accepted by api/claude.js and api/live-query.js.
//
// Required env var: ADMIN_PASSWORD (set in Vercel dashboard)

const crypto = require('crypto');

function issueAdminToken() {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  const exp = Date.now() + 90 * 24 * 60 * 60 * 1000; // 90 days
  const payload = `admin:${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return res.status(500).json({ error: 'Admin auth not configured' });

  const inputBuf = Buffer.from(password);
  const storedBuf = Buffer.from(adminPassword);

  // Constant-time comparison to prevent timing attacks
  if (inputBuf.length !== storedBuf.length || !crypto.timingSafeEqual(inputBuf, storedBuf)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  res.json({ token: issueAdminToken() });
};
