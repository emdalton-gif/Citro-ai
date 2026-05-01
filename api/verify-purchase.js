// api/verify-purchase.js
// Verifies a Stripe Checkout Session and returns order data + a short-lived
// purchase token that authorizes the buyer to call /api/claude.
// Also sends a confirmation email via Resend (non-blocking).

const https = require('https');
const crypto = require('crypto');

function stripeGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.stripe.com',
      path: `/v1${path}`,
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64'),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid Stripe response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function issuePurchaseToken(sessionId) {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  const exp = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  const payload = `purchase:${sessionId}:${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

async function sendConfirmationEmail(toEmail, companyName, sessionId) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return; // skip silently if not configured

  const auditUrl = `https://rootace.ai/audit.html?session_id=${sessionId}`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F5F0E8;font-family:Georgia,serif;">
  <div style="max-width:560px;margin:48px auto;background:#FAF7F2;border-radius:16px;overflow:hidden;border:1px solid rgba(44,35,24,0.1);">
    <div style="background:#2C2318;padding:32px 40px;">
      <span style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:#FAF7F2;">Root</span><span style="font-family:Georgia,serif;font-size:24px;font-style:italic;color:#8B4A2A;">ACE</span>
    </div>
    <div style="padding:40px;">
      <p style="font-family:Georgia,serif;font-size:22px;color:#2C2318;margin:0 0 20px;">Your audit is ready to run.</p>
      <p style="font-size:15px;color:#6B5D4F;line-height:1.75;margin:0 0 16px;">Thanks for your order${companyName ? ` for <strong style="color:#2C2318;">${companyName}</strong>` : ''}. Your Competitive AI Audit is queued and ready — click below to start it now.</p>
      <p style="font-size:15px;color:#6B5D4F;line-height:1.75;margin:0 0 32px;">The audit typically completes in under 15 minutes and runs entirely in your browser. Keep the tab open until results appear.</p>
      <a href="${auditUrl}" style="display:inline-block;background:#8B4A2A;color:#FAF7F2;padding:14px 28px;border-radius:100px;font-size:15px;font-family:Georgia,serif;text-decoration:none;font-weight:bold;">Start my audit →</a>
      <p style="font-size:13px;color:#9E8E7E;margin:32px 0 0;line-height:1.7;">Your results will be saved to your account dashboard at <a href="https://rootace.ai/dashboard.html" style="color:#8B4A2A;">rootace.ai/dashboard.html</a>. If you have any issues, reply to this email or contact <a href="mailto:support@rootpartners.co" style="color:#8B4A2A;">support@rootpartners.co</a>.</p>
    </div>
    <div style="padding:24px 40px;border-top:1px solid rgba(44,35,24,0.08);">
      <p style="font-size:12px;color:#9E8E7E;margin:0;">RootACE by RootPartners LLC &nbsp;·&nbsp; <a href="https://rootace.ai/privacy.html" style="color:#9E8E7E;">Privacy</a> &nbsp;·&nbsp; <a href="https://rootace.ai/terms.html" style="color:#9E8E7E;">Terms</a></p>
    </div>
  </div>
</body>
</html>`;

  const payload = JSON.stringify({
    from: 'RootACE <audit@rootace.ai>',
    to: [toEmail],
    subject: `Your RootACE audit is ready${companyName ? ` — ${companyName}` : ''}`,
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
    }, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', () => resolve()); // never throw — email is non-critical
    req.write(payload);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  try {
    const session = await stripeGet(`/checkout/sessions/${sessionId}`);

    if (session.error) {
      return res.status(400).json({ error: session.error.message });
    }

    // Accept paid one-time payments or active/trialing subscriptions
    const isPaid = session.payment_status === 'paid' || session.status === 'complete';
    if (!isPaid) {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    const token = issuePurchaseToken(sessionId);
    const orderData = session.metadata || {};

    // Send confirmation email (non-blocking — never fails the response)
    const email = session.customer_details?.email || session.customer_email;
    if (email) {
      sendConfirmationEmail(email, orderData.company_name || '', sessionId).catch(() => {});
    }

    res.json({ token, orderData });
  } catch (err) {
    console.error('verify-purchase error:', err.message);
    res.status(500).json({ error: 'Could not verify purchase' });
  }
};
