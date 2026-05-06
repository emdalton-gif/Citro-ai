// api/sub-reset-password.js
// Verifies a reset token and updates the subscriber's password.

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

async function upstashSet(key, value) {
  return upstashCmd(['SET', key, JSON.stringify(value)]);
}

async function upstashDel(key) {
  return upstashCmd(['DEL', key]);
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, hash) => {
      if (err) reject(err);
      else resolve(hash.toString('hex'));
    });
  });
}

function issueSubscriberToken(email) {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const payload = `subscriber:${email}:${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    // Look up reset token
    const resetData = await upstashGet(`sub-reset:${token}`);
    if (!resetData) {
      return res.status(400).json({ error: 'This reset link has expired or already been used. Please request a new one.' });
    }

    const { email } = resetData;

    // Load account
    const account = await upstashGet(`subscriber:${email}`);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    // Hash new password
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(password, salt);

    // Update account
    await upstashSet(`subscriber:${email}`, {
      ...account,
      passwordHash,
      salt,
      updatedAt: Date.now(),
    });

    // Invalidate reset token immediately
    await upstashDel(`sub-reset:${token}`);

    // Issue new session token
    const sessionToken = issueSubscriberToken(email);
    res.json({ token: sessionToken, email });
  } catch (err) {
    console.error('sub-reset-password error:', err.message);
    res.status(500).json({ error: 'Could not reset password' });
  }
};
