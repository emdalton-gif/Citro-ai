// api/create-checkout.js
// Creates a Stripe Checkout Session and returns the checkout URL.
// The buyer's order data is stored in session metadata so we can
// retrieve it after payment to run the audit.

const https = require('https');
const querystring = require('querystring');

function stripePost(path, params) {
  return new Promise((resolve, reject) => {
    // Flatten nested params (e.g. metadata[key], line_items[0][price])
    const flat = {};
    function flatten(obj, prefix) {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}[${k}]` : k;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          flatten(v, key);
        } else if (Array.isArray(v)) {
          v.forEach((item, i) => {
            if (typeof item === 'object') flatten(item, `${key}[${i}]`);
            else flat[`${key}[${i}]`] = item;
          });
        } else {
          flat[key] = v;
        }
      }
    }
    flatten(params);

    const body = querystring.stringify(flat);
    const options = {
      hostname: 'api.stripe.com',
      path: `/v1${path}`,
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
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
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { plan, name, website, industry, email, specific_product, offer, buyer, geo, competitors } = req.body;

  if (!email || !name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const isSubscription = plan === 'professional' || plan === 'active' || plan === 'enterprise';
  let priceId;
  if (plan === 'enterprise') {
    priceId = process.env.STRIPE_ENTERPRISE_PRICE_ID;
  } else if (plan === 'professional' || plan === 'active') {
    priceId = process.env.STRIPE_PROFESSIONAL_PRICE_ID || process.env.STRIPE_ACTIVE_PRICE_ID;
  } else {
    priceId = process.env.STRIPE_SNAPSHOT_PRICE_ID;
  }

  const origin = req.headers.origin || 'https://rootpartners.co';

  // Build session params — add a 7-day free trial for Professional plan
  const sessionParams = {
    mode: isSubscription ? 'subscription' : 'payment',
    allow_promotion_codes: true,
    customer_email: email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: isSubscription
      ? `${origin}/sub-confirm.html?session_id={CHECKOUT_SESSION_ID}`
      : `${origin}/confirm.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/order.html`,
    metadata: {
      plan: plan || 'snapshot',
      company_name: (name || '').slice(0, 400),
      website: (website || '').slice(0, 400),
      industry: (industry || '').slice(0, 100),
      email: (email || '').slice(0, 200),
      specific_product: (specific_product || '').slice(0, 400),
      offer: (offer || '').slice(0, 480),
      buyer: (buyer || '').slice(0, 480),
      geo: (geo || '').slice(0, 100),
      competitors: (competitors || '').slice(0, 400),
    },
  };

  // 7-day free trial for Professional (card collected upfront, charged after trial)
  if (plan === 'professional') {
    sessionParams.subscription_data = { trial_period_days: 7 };
  }

  try {
    const session = await stripePost('/checkout/sessions', sessionParams);

    if (session.error) {
      return res.status(400).json({ error: session.error.message });
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err.message);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
};
