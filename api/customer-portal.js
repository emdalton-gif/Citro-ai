// api/customer-portal.js
// Creates a Stripe Customer Portal session for the authenticated customer.
const https = require('https');
const querystring = require('querystring');
const crypto = require('crypto');
function verifyCustomerToken(token) {
  if (!token) return null;
  try {
    const { p: payload, s: sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const parts = payload.split(':');
    // Accept both legacy "customer:" tokens and the subscriber dashboard's "subscriber:" tokens.
    if (parts[0] !== 'customer' && parts[0] !== 'subscriber') return null;
    if (Date.now() > parseInt(parts[parts.length - 1], 10)) return null;
    return parts.slice(1, -1).join(':');
  } catch { return null; }
}
function stripeRequest(method, path, params) {
  return new Promise((resolve, reject) => {
    const body = params ? querystring.stringify(params) : '';
    const options = {
      hostname: 'api.stripe.com',
      path: `/v1${path}`,
      method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64'),
      },
    };
    if (body) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid Stripe response')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const email = verifyCustomerToken(token);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });
  const origin = req.headers.origin || 'https://rootpartners.co';
  try {
    // Look up Stripe customer by email
    const customers = await stripeRequest('GET', `/customers?email=${encodeURIComponent(email)}&limit=1`);
    if (!customers.data || customers.data.length === 0) {
      return res.status(404).json({ error: 'No billing account found for this email. If you purchased with a different address, contact support@getcitro.ai.' });
    }
    const customerId = customers.data[0].id;
    // Create portal session
    const session = await stripeRequest('POST', '/billing_portal/sessions', {
      customer: customerId,
      return_url: `${origin}/dashboard.html`,
    });
    if (session.error) {
      return res.status(400).json({ error: session.error.message });
    }
    res.json({ url: session.url });
  } catch (err) {
    console.error('customer-portal error:', err.message);
    res.status(500).json({ error: 'Could not open billing portal' });
  }
};
