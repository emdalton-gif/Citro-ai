// api/sub-webhook.js
// Stripe webhook handler for subscription lifecycle events.
// Keeps subscriber subscription status in sync with Stripe.
// Events handled:
//   customer.subscription.updated  → update status (active, past_due, etc.)
//   customer.subscription.deleted  → mark canceled
//   invoice.payment_failed         → mark past_due, send warning email

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

async function upstashSet(key, value) {
  return upstashCmd(['SET', key, JSON.stringify(value)]);
}

// Find subscriber by Stripe customer ID
async function findSubscriberByCustomerId(customerId) {
  // We store an index: stripe-customer:{customerId} → email
  const r = await upstashCmd(['GET', `stripe-customer:${customerId}`]);
  if (!r.result) return null;
  const email = r.result.replace(/^"|"$/g, '');
  return upstashGet(`subscriber:${email}`);
}

async function updateSubscriberStatus(customerId, status) {
  const r = await upstashCmd(['GET', `stripe-customer:${customerId}`]);
  if (!r.result) return false;
  const email = r.result.replace(/^"|"$/g, '');
  const account = await upstashGet(`subscriber:${email}`);
  if (!account) return false;
  await upstashSet(`subscriber:${email}`, { ...account, subscriptionStatus: status, updatedAt: Date.now() });
  return email;
}

function sendPaymentFailedEmail(toEmail) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return Promise.resolve();

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:Inter,system-ui,sans-serif;">
  <div style="max-width:540px;margin:48px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E2E8F0;">
    <div style="background:#0B0F1A;padding:28px 36px;">
      <span style="font-size:18px;font-weight:700;color:#fff;">Root</span><span style="font-size:18px;font-weight:400;color:rgba(255,255,255,0.5);">ACE</span>
    </div>
    <div style="padding:36px;">
      <p style="font-size:20px;font-weight:700;color:#0B0F1A;margin:0 0 16px;">Payment issue with your subscription</p>
      <p style="font-size:15px;color:#64748B;line-height:1.7;margin:0 0 16px;">We couldn't process your most recent Active Optimization payment. Your account is still active while we retry, but please update your payment method to avoid any interruption.</p>
      <a href="https://getcitro.ai/sub-dashboard.html" style="display:inline-block;background:#2563EB;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;margin-bottom:24px;">Update Payment Method →</a>
      <p style="font-size:13px;color:#94A3B8;line-height:1.7;margin:0;">If you need help, reply to this email or reach us at <a href="mailto:support@rootpartners.co" style="color:#2563EB;">support@rootpartners.co</a></p>
    </div>
  </div>
</body>
</html>`;

  const payload = JSON.stringify({
    from: 'Citro <audit@getcitro.ai>',
    to: [toEmail],
    subject: 'Action needed: payment issue with your Citro subscription',
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
    }, () => { resolve(); });
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

// Verify Stripe webhook signature
function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = sigHeader.split(',');
  let timestamp = '';
  const signatures = [];
  for (const part of parts) {
    const [k, v] = part.split('=');
    if (k === 't') timestamp = v;
    if (k === 'v1') signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;

  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return signatures.some(sig => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch { return false; }
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const sigHeader = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET;

  // Read raw body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');

  if (webhookSecret && sigHeader) {
    if (!verifyStripeSignature(rawBody, sigHeader, webhookSecret)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        // Subscription checkout completed — store the stripe-customer index
        const session = event.data.object;
        if (session.mode === 'subscription' && session.customer) {
          const email = session.customer_details?.email || session.customer_email || '';
          if (email) {
            const normalizedEmail = email.toLowerCase().trim();
            // Store customer ID → email index for future webhook lookups
            await upstashCmd(['SET', `stripe-customer:${session.customer}`, JSON.stringify(normalizedEmail)]);
            // Update subscriber plan in case they upgraded an existing account
            const plan = session.metadata?.plan;
            if (plan) {
              const account = await upstashGet(`subscriber:${normalizedEmail}`);
              if (account) {
                await upstashSet(`subscriber:${normalizedEmail}`, { ...account, plan, updatedAt: Date.now() });
              }
            }
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await updateSubscriberStatus(sub.customer, sub.status);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await updateSubscriberStatus(sub.customer, 'canceled');
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const email = await updateSubscriberStatus(invoice.customer, 'past_due');
        if (email) {
          sendPaymentFailedEmail(email).catch(() => {});
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        await updateSubscriberStatus(invoice.customer, 'active');
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('sub-webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};
