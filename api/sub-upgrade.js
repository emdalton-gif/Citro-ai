// api/sub-upgrade.js
// Upgrades a Professional subscriber to Enterprise on their existing Stripe
// subscription, so they are never billed for two plans.
//
//   GET  → what the upgrade will cost today (for the confirm screen)
//   POST → switches the subscription's price to Enterprise, charges the
//          prorated difference now (or the full price if still in the trial),
//          sets the account to Enterprise and turns the business into the
//          first Enterprise brand with its history.

const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');
const { convertProfileToProperty } = require('./_lib/plan-change');

function verifySubscriberToken(token) {
  if (!token) return null;
  try {
    const { p: payload, s: sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const parts = payload.split(':');
    if (parts[0] !== 'subscriber') return null;
    if (Date.now() > parseInt(parts[parts.length - 1], 10)) return null;
    return parts.slice(1, -1).join(':');
  } catch { return null; }
}

async function upstashCmd(cmd) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return res.json();
}
async function upstashGet(key) { const r = await upstashCmd(['GET', key]); return r.result ? JSON.parse(r.result) : null; }
async function upstashSet(key, value) { return upstashCmd(['SET', key, JSON.stringify(value)]); }

function stripe(method, path, params) {
  return new Promise((resolve, reject) => {
    const body = params ? querystring.stringify(params) : '';
    const req = https.request({
      hostname: 'api.stripe.com', path: `/v1${path}`, method,
      headers: {
        Authorization: 'Basic ' + Buffer.from((process.env.STRIPE_SECRET_KEY || '') + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid Stripe response')); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const money = cents => '$' + (Math.max(0, cents) / 100).toFixed(2);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = req.headers['authorization'] || '';
  const email = verifySubscriberToken(auth.startsWith('Bearer ') ? auth.slice(7) : null);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  const enterprisePrice = process.env.STRIPE_ENTERPRISE_PRICE_ID;
  if (!enterprisePrice) return res.status(500).json({ error: 'Enterprise plan is not configured' });

  try {
    const account = await upstashGet(`subscriber:${email}`);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.plan === 'enterprise') return res.status(400).json({ error: 'You are already on Enterprise.' });
    if (!account.stripeSubscriptionId) {
      return res.status(400).json({ error: 'We could not find your subscription. Please email support@getcitro.ai and we will upgrade you.' });
    }

    const sub = await stripe('GET', `/subscriptions/${encodeURIComponent(account.stripeSubscriptionId)}`);
    if (!sub || sub.error) return res.status(400).json({ error: 'We could not load your subscription. Please email support@getcitro.ai.' });
    if (!['active', 'trialing', 'past_due'].includes(sub.status)) {
      return res.status(400).json({ error: 'Your subscription is not active. Please resubscribe from the Plans page.' });
    }
    const item = sub.items?.data?.[0];
    if (!item) return res.status(400).json({ error: 'We could not read your subscription. Please email support@getcitro.ai.' });
    const inTrial = sub.status === 'trialing';

    // What they pay today: the full price when a trial ends now, otherwise
    // Stripe's proration for the rest of the current period.
    if (req.method === 'GET') {
      let preview = await stripe('POST', '/invoices/create_preview', {
        customer: sub.customer,
        subscription: sub.id,
        'subscription_details[items][0][id]': item.id,
        'subscription_details[items][0][price]': enterprisePrice,
        'subscription_details[proration_behavior]': 'always_invoice',
        ...(inTrial ? { 'subscription_details[trial_end]': 'now' } : {}),
      });
      if (!preview || preview.error) {
        // Older Stripe API versions only have the upcoming-invoice endpoint.
        preview = await stripe('GET', '/invoices/upcoming?' + querystring.stringify({
          customer: sub.customer,
          subscription: sub.id,
          'subscription_items[0][id]': item.id,
          'subscription_items[0][price]': enterprisePrice,
          subscription_proration_behavior: 'always_invoice',
          ...(inTrial ? { subscription_trial_end: 'now' } : {}),
        }));
      }
      const dueToday = preview && !preview.error && typeof preview.amount_due === 'number' ? preview.amount_due : null;
      return res.json({ inTrial, dueToday: dueToday == null ? null : money(dueToday), monthly: '$299.00' });
    }

    const updated = await stripe('POST', `/subscriptions/${encodeURIComponent(sub.id)}`, {
      'items[0][id]': item.id,
      'items[0][price]': enterprisePrice,
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
      ...(inTrial ? { trial_end: 'now' } : {}),
      'metadata[plan]': 'enterprise',
    });
    if (!updated || updated.error) {
      const msg = updated?.error?.message || 'Stripe declined the change.';
      return res.status(402).json({ error: `Your card was not charged and your plan has not changed. ${msg}` });
    }

    const fresh = await upstashGet(`subscriber:${email}`) || account;
    await upstashSet(`subscriber:${email}`, {
      ...fresh,
      plan: 'enterprise',
      subscriptionStatus: updated.status === 'trialing' ? 'active' : (updated.status || 'active'),
      upgradedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { property } = await convertProfileToProperty(email, upstashGet, upstashSet);

    return res.json({ success: true, plan: 'enterprise', propertyId: property?.id || null });
  } catch (err) {
    console.error('sub-upgrade error:', err.message);
    res.status(500).json({ error: 'Something went wrong finishing your upgrade. Please email support@getcitro.ai and we will sort it out today.' });
  }
};
