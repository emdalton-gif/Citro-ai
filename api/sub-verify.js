// api/sub-verify.js
// Verifies a Stripe subscription checkout session.
// Returns the session metadata (company profile) and Stripe IDs
// so the confirm page can pre-fill the account creation form.

const https = require('https');

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

    // Must be a completed subscription checkout
    const isComplete = session.status === 'complete' || session.payment_status === 'paid';
    if (!isComplete) {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    const email = session.customer_details?.email || session.customer_email || '';
    const meta = session.metadata || {};

    res.json({
      email,
      plan: meta.plan || 'professional',
      stripeCustomerId: session.customer || null,
      stripeSubscriptionId: session.subscription || null,
      profile: {
        company_name: meta.company_name || '',
        website: meta.website || '',
        industry: meta.industry || '',
        specific_product: meta.specific_product || '',
        offer: meta.offer || '',
        buyer: meta.buyer || '',
        geo: meta.geo || '',
        competitors: meta.competitors || '',
      },
    });
  } catch (err) {
    console.error('sub-verify error:', err.message);
    res.status(500).json({ error: 'Could not verify subscription' });
  }
};
