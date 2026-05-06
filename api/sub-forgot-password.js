// api/sub-forgot-password.js
// Generates a time-limited password reset token and emails it to the subscriber.

const crypto = require('crypto');
const https = require('https');

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

async function upstashSetEx(key, value, ttlSeconds) {
  return upstashCmd(['SET', key, JSON.stringify(value), 'EX', ttlSeconds]);
}

function sendResetEmail(toEmail, resetUrl) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return Promise.resolve();

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:Inter,system-ui,sans-serif;">
  <div style="max-width:520px;margin:48px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E2E8F0;">
    <div style="background:#0B0F1A;padding:28px 36px;">
      <span style="font-size:18px;font-weight:700;color:#fff;">Root</span><span style="font-size:18px;font-weight:800;color:#2563EB;">ACE</span>
      <span style="font-size:13px;color:rgba(255,255,255,0.4);margin-left:12px;">Active Optimization</span>
    </div>
    <div style="padding:36px;">
      <p style="font-size:20px;font-weight:700;color:#0B0F1A;margin:0 0 12px;">Reset your password</p>
      <p style="font-size:15px;color:#64748B;line-height:1.7;margin:0 0 28px;">We received a request to reset the password for your RootACE account. Click the button below to choose a new password. This link expires in 1 hour.</p>
      <a href="${resetUrl}" style="display:inline-block;background:#2563EB;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;margin-bottom:24px;">Reset password →</a>
      <p style="font-size:13px;color:#94A3B8;line-height:1.7;margin:0;">If you didn't request this, you can safely ignore this email — your password won't change.<br><br>Questions? Reply to this email or contact <a href="mailto:support@rootpartners.co" style="color:#2563EB;">support@rootpartners.co</a></p>
    </div>
  </div>
</body>
</html>`;

  const payload = JSON.stringify({
    from: 'RootACE <audit@rootace.ai>',
    to: [toEmail],
    subject: 'Reset your RootACE password',
    html,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, () => resolve());
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const normalized = email.toLowerCase().trim();

  try {
    const account = await upstashGet(`subscriber:${normalized}`);

    // Always return success to prevent email enumeration
    if (!account) {
      return res.json({ success: true });
    }

    // Generate a secure reset token
    const token = crypto.randomBytes(32).toString('hex');
    const ttl = 60 * 60; // 1 hour

    // Store token in Upstash with TTL
    await upstashSetEx(`sub-reset:${token}`, { email: normalized }, ttl);

    // Send reset email
    const resetUrl = `https://rootace.ai/sub-reset-password.html?token=${token}`;
    await sendResetEmail(normalized, resetUrl);

    res.json({ success: true });
  } catch (err) {
    console.error('sub-forgot-password error:', err.message);
    res.status(500).json({ error: 'Could not send reset email' });
  }
};
