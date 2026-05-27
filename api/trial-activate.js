// api/trial-activate.js
// Called from trial-confirm.html after Stripe redirects back.
// 1. Retrieves the Stripe Checkout Session to verify it completed.
// 2. Looks up the pre-created subscriber (created by start-trial.js).
// 3. Updates subscriptionStatus to 'active' and stores Stripe IDs.
// 4. Issues and returns a 30-day JWT so the confirm page can auto-login.

const crypto = require('crypto');
const https  = require('https');

// ── Upstash helpers ──────────────────────────────────────────────────────────

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

// ── JWT ──────────────────────────────────────────────────────────────────────

function issueSubscriberToken(email) {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  const exp    = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const payload = `subscriber:${email}:${exp}`;
  const sig     = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

// ── Stripe GET ───────────────────────────────────────────────────────────────

function stripeGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.stripe.com',
      path:     `/v1${path}`,
      method:   'GET',
      headers: {
        Authorization: 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64'),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid Stripe response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  try {
    // ── 1. Verify Stripe session ──────────────────────────────────────────────
    const session = await stripeGet(`/checkout/sessions/${sessionId}`);

    if (session.error) {
      return res.status(400).json({ error: session.error.message });
    }

    // Trials: status = 'complete', payment_status = 'no_payment_required'
    if (session.status !== 'complete') {
      return res.status(402).json({ error: 'Checkout not completed' });
    }

    // ── 2. Resolve the subscriber email ───────────────────────────────────────
    // client_reference_id is set to the normalized email by start-trial.js
    const email = (
      session.client_reference_id ||
      session.customer_details?.email ||
      session.customer_email ||
      ''
    ).toLowerCase().trim();

    if (!email) {
      return res.status(400).json({ error: 'Could not determine subscriber email' });
    }

    // ── 3. Fetch & update subscriber record ───────────────────────────────────
    const subscriber = await upstashGet(`subscriber:${email}`);
    if (!subscriber) {
      // Subscriber wasn't pre-created (shouldn't happen in normal flow).
      // Create a minimal record so the user can still access the dashboard.
      await upstashSet(`subscriber:${email}`, {
        email,
        plan:                'professional',
        stripeCustomerId:    session.customer || null,
        stripeSubscriptionId: session.subscription || null,
        subscriptionStatus:  'active',
        createdAt:           Date.now(),
      });
    } else {
      await upstashSet(`subscriber:${email}`, {
        ...subscriber,
        stripeCustomerId:    session.customer    || subscriber.stripeCustomerId,
        stripeSubscriptionId: session.subscription || subscriber.stripeSubscriptionId,
        subscriptionStatus:  'active',
        activatedAt:         Date.now(),
      });
    }

    // ── 4. Store Stripe customer → email reverse lookup ───────────────────────
    if (session.customer) {
      await upstashSet(`stripe-customer:${session.customer}`, email);
    }

    // ── 5. Issue JWT ──────────────────────────────────────────────────────────
    const token = issueSubscriberToken(email);

    return res.json({ token, email });

  } catch (err) {
    console.error('trial-activate error:', err.message);
    res.status(500).json({ error: 'Could not activate trial' });
  }
};
