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

  const auditUrl = `https://getcitro.ai/audit.html?session_id=${sessionId}`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0B0F1A;font-family:'Inter',system-ui,sans-serif;">
  <div style="max-width:560px;margin:48px auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
    <div style="background:#0B0F1A;padding:28px 40px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">Citr</span><span style="font-size:22px;font-weight:800;color:#38BDF8;letter-spacing:-0.3px;">o</span><span style="font-size:22px;color:#38BDF8;">.</span>
    </div>
    <div style="padding:40px;">
      <p style="font-size:22px;font-weight:700;color:#F8FAFC;margin:0 0 20px;line-height:1.3;">Your Citro audit is ready to run.</p>
      <p style="font-size:15px;color:#94A3B8;line-height:1.75;margin:0 0 16px;">Thanks for your order${companyName ? ` for <strong style="color:#F8FAFC;">${companyName}</strong>` : ''}. Your Citro audit is queued and ready — click below to start it now.</p>
      <p style="font-size:15px;color:#94A3B8;line-height:1.75;margin:0 0 32px;">The audit typically completes in under 5 minutes and runs entirely in your browser. Keep the tab open until results appear.</p>
      <a href="${auditUrl}" style="display:inline-block;background:#2563EB;color:#ffffff;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;text-decoration:none;">Start my audit →</a>
      <p style="font-size:13px;color:#64748B;margin:32px 0 0;line-height:1.7;">Your results will be saved to your account dashboard at <a href="https://getcitro.ai/dashboard.html" style="color:#60A5FA;">getcitro.ai/dashboard.html</a>. If you have any issues, reply to this email or contact <a href="mailto:support@rootpartners.co" style="color:#60A5FA;">support@rootpartners.co</a>.</p>
      <div style="margin-top:40px;padding:28px 32px;background:#1E293B;border-radius:12px;border:1px solid rgba(255,255,255,0.06);">
        <p style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#60A5FA;margin:0 0 10px;">After your audit</p>
        <p style="font-size:18px;font-weight:700;color:#F8FAFC;margin:0 0 10px;line-height:1.3;">AI recommendations shift every month. Know if yours are improving.</p>
        <p style="font-size:14px;color:#94A3B8;line-height:1.7;margin:0 0 20px;">Your Snapshot shows where you stand today. Professional re-runs your simulation every month, tracks your Citro Score, and flags new competitive threats as they appear. Snapshot buyers get their first month credited.</p>
        <a href="https://getcitro.ai/subscribe.html?plan=professional" style="display:inline-block;background:#2563EB;color:#ffffff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;">See Professional — $119/mo →</a>
      </div>
    </div>
    <div style="padding:24px 40px;border-top:1px solid rgba(255,255,255,0.06);">
      <p style="font-size:12px;color:#475569;margin:0;">Citro by RootPartners LLC &nbsp;·&nbsp; <a href="https://getcitro.ai/privacy.html" style="color:#475569;">Privacy</a> &nbsp;·&nbsp; <a href="https://getcitro.ai/terms.html" style="color:#475569;">Terms</a></p>
    </div>
  </div>
</body>
</html>`;

  const payload = JSON.stringify({
    from: 'Citro <audit@getcitro.ai>',
    to: [toEmail],
    subject: `Your Citro audit is ready${companyName ? ` — ${companyName}` : ''}`,
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

function resendSend(apiKey, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

function emailHeader() {
  return `<div style="background:#0B0F1A;padding:28px 40px;">
    <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:22px;font-weight:800;color:#F8FAFC;letter-spacing:-0.02em;">Citr</span><span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:22px;font-weight:800;color:#38BDF8;letter-spacing:-0.02em;">o</span><span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:22px;font-weight:800;color:#38BDF8;letter-spacing:-0.02em;">.</span>
  </div>`;
}

function emailFooter() {
  return `<div style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.08);">
    <p style="font-size:12px;color:rgba(248,250,252,0.40);margin:0;">Citro by RootPartners LLC &nbsp;·&nbsp; <a href="https://getcitro.ai/privacy.html" style="color:rgba(248,250,252,0.40);">Privacy</a> &nbsp;·&nbsp; <a href="https://getcitro.ai/terms.html" style="color:rgba(248,250,252,0.40);">Terms</a></p>
  </div>`;
}

function upgradeCta() {
  return `<div style="margin-top:36px;padding:24px 28px;background:#0B0F1A;border-radius:12px;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#38BDF8;margin:0 0 8px;">Professional — $119/month</p>
    <p style="font-size:14px;color:rgba(248,250,252,0.65);line-height:1.65;margin:0 0 16px;">Monthly re-simulation, score tracking, and competitive alerts — automatically. Snapshot buyers get their first month credited.</p>
    <a href="https://getcitro.ai/subscribe.html?plan=professional" style="display:inline-block;background:#2563EB;color:#F8FAFC;padding:11px 22px;border-radius:8px;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-decoration:none;font-weight:bold;">Start Professional →</a>
  </div>`;
}

async function sendDripSequence(toEmail, companyName) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const co = companyName ? `<strong style="color:#F8FAFC;">${companyName}</strong>` : 'your company';
  const dashUrl = 'https://getcitro.ai/dashboard.html';

  // Day 1 — Understanding your score
  const day1At = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const email1Html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0D1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:560px;margin:48px auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
  ${emailHeader()}
  <div style="padding:36px 40px;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;color:#F8FAFC;margin:0 0 18px;line-height:1.3;">What your Citro Score actually means</p>
    <p style="font-size:15px;color:rgba(248,250,252,0.70);line-height:1.8;margin:0 0 16px;">Now that your audit for ${co} is done, here's the context that makes the score useful.</p>
    <p style="font-size:15px;color:rgba(248,250,252,0.70);line-height:1.8;margin:0 0 16px;">The seven platforms we simulate — ChatGPT, Perplexity, Gemini, Claude, Copilot, Meta AI, and Grok — weight information differently. Perplexity heavily favors recent web citations. ChatGPT draws more from its training data and broad web context. Gemini weights Google-indexed content and Knowledge Graph entries.</p>
    <p style="font-size:15px;color:rgba(248,250,252,0.70);line-height:1.8;margin:0 0 16px;">This means a low score on one platform doesn't mean a low score on all of them — and the 90-day plan in your report is sequenced to target the platforms where improvement is fastest first.</p>
    <p style="font-size:15px;color:rgba(248,250,252,0.70);line-height:1.8;margin:0 0 28px;">Your results are saved at your dashboard — you can return to them anytime.</p>
    <a href="${dashUrl}" style="display:inline-block;background:#2563EB;color:#F8FAFC;padding:13px 26px;border-radius:100px;font-size:15px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-decoration:none;font-weight:bold;">View your results →</a>
    ${upgradeCta()}
  </div>
  ${emailFooter()}
</div>
</body></html>`;

  // Day 3 — What's moving in AI recommendations
  const day3At = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const email2Html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0D1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:560px;margin:48px auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
  ${emailHeader()}
  <div style="padding:36px 40px;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;color:#F8FAFC;margin:0 0 18px;line-height:1.3;">AI recommendations are not static</p>
    <p style="font-size:15px;color:rgba(248,250,252,0.70);line-height:1.8;margin:0 0 16px;">One thing we see consistently across audits: companies that ran a simulation 90 days ago often look very different today — without making any changes themselves.</p>
    <p style="font-size:15px;color:rgba(248,250,252,0.70);line-height:1.8;margin:0 0 16px;">Competitors publish new content. AI platforms update their retrieval logic. A vendor that wasn't mentioned in your category six months ago starts showing up in every recommendation. This happens silently, and most companies don't find out until a prospect tells them they went with someone else.</p>
    <p style="font-size:15px;color:rgba(248,250,252,0.70);line-height:1.8;margin:0 0 16px;">Your Snapshot is a point-in-time picture. It's accurate today. Whether it's still accurate in 60 days depends on what your competitors do between now and then.</p>
    <p style="font-size:15px;color:rgba(248,250,252,0.70);line-height:1.8;margin:0 0 28px;">If you've started working on the 90-day plan, the next question is: how do you know if it's working?</p>
    ${upgradeCta()}
  </div>
  ${emailFooter()}
</div>
</body></html>`;

  // Day 7 — Are you improving?
  const day7At = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const email3Html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0D1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:560px;margin:48px auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
  ${emailHeader()}
  <div style="padding:36px 40px;">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;color:#F8FAFC;margin:0 0 18px;line-height:1.3;">It's been a week. Is it working?</p>
    <p style="font-size:15px;color:rgba(248,250,252,0.70);line-height:1.8;margin:0 0 16px;">If you've made any changes based on your audit — updating your website copy, publishing content, adjusting how you describe your category — the right question now is whether those changes are showing up in AI recommendations.</p>
    <p style="font-size:15px;color:rgba(248,250,252,0.70);line-height:1.8;margin:0 0 16px;">That's exactly what Professional tracks. Run a simulation whenever you want, compare it against your baseline, and see your score move in real time as your work compounds.</p>
    <p style="font-size:15px;color:rgba(248,250,252,0.70);line-height:1.8;margin:0 0 28px;">As a Snapshot buyer, your first month is credited. So if you start now, the first month costs you nothing beyond what you already paid.</p>
    <a href="https://getcitro.ai/subscribe.html?plan=professional" style="display:inline-block;background:#2563EB;color:#F8FAFC;padding:14px 28px;border-radius:100px;font-size:15px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-decoration:none;font-weight:bold;">Start Professional — first month free →</a>
    <p style="font-size:13px;color:rgba(248,250,252,0.45);margin:24px 0 0;line-height:1.6;">Questions? Reply to this email or reach us at <a href="mailto:support@rootpartners.co" style="color:#38BDF8;">support@rootpartners.co</a>.</p>
  </div>
  ${emailFooter()}
</div>
</body></html>`;

  // Schedule all three — non-blocking, never throw
  await Promise.allSettled([
    resendSend(apiKey, {
      from: 'Eric at Citro <eric@getcitro.ai>',
      to: [toEmail],
      subject: `What your Citro Score actually means${companyName ? ` — ${companyName}` : ''}`,
      html: email1Html,
      scheduled_at: day1At,
    }),
    resendSend(apiKey, {
      from: 'Eric at Citro <eric@getcitro.ai>',
      to: [toEmail],
      subject: 'AI recommendations are not static',
      html: email2Html,
      scheduled_at: day3At,
    }),
    resendSend(apiKey, {
      from: 'Eric at Citro <eric@getcitro.ai>',
      to: [toEmail],
      subject: `It's been a week. Is it working?`,
      html: email3Html,
      scheduled_at: day7At,
    }),
  ]);
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
      sendDripSequence(email, orderData.company_name || '').catch(() => {});
    }

    res.json({ token, orderData });
  } catch (err) {
    console.error('verify-purchase error:', err.message);
    res.status(500).json({ error: 'Could not verify purchase' });
  }
};
