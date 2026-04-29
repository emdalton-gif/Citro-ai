// api/auth-login.js
// Verifies customer email + password and issues a 30-day session token.

const crypto = require('crypto');

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

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, hash) => {
      if (err) reject(err);
      else resolve(hash.toString('hex'));
    });
  });
}

function issueCustomerToken(email) {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const payload = `customer:${email}:${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const normalized = email.toLowerCase().trim();

  try {
    const account = await upstashGet(`customer:${normalized}`);
    if (!account) return res.status(401).json({ error: 'Invalid email or password' });

    const hash = await hashPassword(password, account.salt);
    const hashBuf = Buffer.from(hash, 'hex');
    const storedBuf = Buffer.from(account.passwordHash, 'hex');

    if (hashBuf.length !== storedBuf.length || !crypto.timingSafeEqual(hashBuf, storedBuf)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = issueCustomerToken(normalized);
    res.json({ token, email: normalized });
  } catch (err) {
    console.error('auth-login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
};
