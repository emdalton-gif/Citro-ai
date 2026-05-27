// api/start-trial.js
// Called from start.html Step 5.
// 1. Hashes the password and creates a subscriber record in Redis with
//    subscriptionStatus: 'pending_payment'.
// 2. Stores the business profile and personas so they survive the Stripe redirect.
// 3. Creates a Stripe Checkout Session (subscription mode, 7-day free trial).
// 4. Returns { url } — the Stripe-hosted checkout page.
//
// After payment, Stripe redirects to /trial-confirm.html?session_id=...
// That page calls /api/trial-activate to flip status to 'active' and issue a JWT.

const crypto = require('crypto');
const https  = require('https');
const querystring = require('querystring');

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

// ── Password hashing ─────────────────────────────────────────────────────────

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, hash) => {
      if (err) reject(err);
      else resolve(hash.toString('hex'));
    });
  });
}

// ── Stripe ───────────────────────────────────────────────────────────────────

function stripePost(path, params) {
  return new Promise((resolve, reject) => {
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
        Authorization: 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
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
    req.write(body);
    req.end();
  });
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { email, password, profile, personas } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!profile || (!profile.company_name && !profile.name)) {
    return res.status(400).json({ error: 'Business name is required' });
  }
  // Normalize — rest of the system uses company_name; accept either
  if (!profile.company_name) profile.company_name = profile.name;
  if (!profile.name) profile.name = profile.company_name;

  const normalized = email.toLowerCase().trim();

  try {
    // ── 1. Create / update subscriber record ─────────────────────────────────
    const existing = await upstashGet(`subscriber:${normalized}`);

    if (!existing) {
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = await hashPassword(password, salt);

      await upstashSet(`subscriber:${normalized}`, {
        email:               normalized,
        passwordHash,
        salt,
        plan:                'professional',
        stripeCustomerId:    null,
        stripeSubscriptionId: null,
        subscriptionStatus:  'pending_payment',
        createdAt:           Date.now(),
      });
    }
    // If account exists (e.g. a retry) leave it as-is — trial-activate will
    // update Stripe IDs and flip status to active.

    // ── 2. Store business profile ─────────────────────────────────────────────
    await upstashSet(`subscriber-profile:${normalized}`, {
      ...profile,
      updatedAt: Date.now(),
    });

    // ── 3. Store personas ─────────────────────────────────────────────────────
    if (personas && personas.length) {
      await upstashSet(`subscriber-personas:${normalized}`, {
        personas,
        updatedAt: Date.now(),
      });
    }

    // ── 4. Create Stripe Checkout Session ─────────────────────────────────────
    const origin  = req.headers.origin || 'https://getcitro.ai';
    const priceId = process.env.STRIPE_PROFESSIONAL_PRICE_ID || process.env.STRIPE_ACTIVE_PRICE_ID;

    const session = await stripePost('/checkout/sessions', {
      mode:                 'subscription',
      allow_promotion_codes: true,
      customer_email:       normalized,
      client_reference_id:  normalized,   // used by trial-activate to look up the pre-created account
      line_items:           [{ price: priceId, quantity: 1 }],
      subscription_data:    { trial_period_days: 7 },
      success_url:          `${origin}/trial-confirm.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:           `${origin}/start.html`,
      metadata: {
        plan:        'professional',
        email:       normalized,
        company_name: (profile.name    || '').slice(0, 400),
        website:      (profile.website || '').slice(0, 400),
        industry:     (profile.industry || '').slice(0, 100),
        offer:        (profile.offer   || '').slice(0, 480),
        buyer:        (profile.buyer   || '').slice(0, 480),
        geo:          (profile.geo     || '').slice(0, 100),
        competitors:  (profile.competitors || '').slice(0, 400),
      },
    });

    if (session.error) {
      return res.status(400).json({ error: session.error.message });
    }

    return res.json({ url: session.url });

  } catch (err) {
    console.error('start-trial error:', err.message);
    res.status(500).json({ error: 'Could not start trial' });
  }
};
