// api/verify-purchase.js
// Verifies a Stripe Checkout Session and returns order data + a short-lived
// purchase token that authorizes the buyer to call /api/claude.

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

    res.json({ token, orderData });
  } catch (err) {
    console.error('verify-purchase error:', err.message);
    res.status(500).json({ error: 'Could not verify purchase' });
  }
};
