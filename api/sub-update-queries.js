// api/sub-update-queries.js
// Saves an Enterprise property's question set as a new version.
//
// The question set defines a property's score history, so it is only replaced
// deliberately: the customer edits or regenerates it on the review screen and
// this endpoint stores it as a new numbered version. Runs are stamped with the
// version they used (api/sub-save-run.js) and the dashboard marks where the
// version changes, so a score move caused by new questions is never mistaken
// for a change in visibility.

const crypto = require('crypto');

const LIVE_PLATFORMS = ['ChatGPT', 'Perplexity', 'Google Gemini', 'Claude', 'Grok'];
const MIN_QUERIES = 5;
const MAX_QUERIES = 15;
const MAX_BRAND_QUERIES = 2;

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

// Same fingerprint formula as api/sub-save-run.js, so ids stay comparable.
function querySetFingerprint(queries) {
  return crypto.createHash('sha256')
    .update(queries.map(q => String(q?.text || '').trim().toLowerCase()).sort().join('|'))
    .digest('hex').slice(0, 12);
}

// Order-insensitive comparison that also notices platform and brand changes,
// which the text-only fingerprint cannot see.
function setKey(queries) {
  return queries
    .map(q => `${String(q.text).trim().toLowerCase()}::${q.platform}::${q.brand_specific ? 1 : 0}`)
    .sort().join('|');
}

// Returns an error string, or null when the set is valid.
function validate(queries) {
  if (!Array.isArray(queries)) return 'queries must be an array';
  if (queries.length < MIN_QUERIES || queries.length > MAX_QUERIES) {
    return `A question set needs between ${MIN_QUERIES} and ${MAX_QUERIES} questions.`;
  }
  const seen = new Set();
  for (const q of queries) {
    const text = typeof q?.text === 'string' ? q.text.trim() : '';
    if (text.length < 3 || text.length > 200) return 'Each question must be between 3 and 200 characters.';
    if (!LIVE_PLATFORMS.includes(q.platform)) return `Unknown platform: ${q.platform}`;
    const k = text.toLowerCase() + '::' + q.platform;
    if (seen.has(k)) return `Duplicate question on ${q.platform}: "${text}"`;
    seen.add(k);
  }
  if (queries.filter(q => q.brand_specific).length > MAX_BRAND_QUERIES) {
    return `At most ${MAX_BRAND_QUERIES} questions can name your brand.`;
  }
  const missing = LIVE_PLATFORMS.filter(p => !queries.some(q => q.platform === p && !q.brand_specific));
  if (missing.length) {
    return `Every platform needs at least one question that doesn't name your brand. Missing: ${missing.join(', ')}.`;
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const email = verifySubscriberToken(token);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  const { propertyId, queries: rawQueries, source } = req.body || {};
  if (!propertyId) return res.status(400).json({ error: 'Missing propertyId' });

  const queries = Array.isArray(rawQueries) ? rawQueries.map(q => ({
    text: String(q?.text || '').trim().replace(/\s+/g, ' '),
    platform: q?.platform,
    brand_specific: !!q?.brand_specific,
  })) : rawQueries;

  const invalid = validate(queries);
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    const account = await upstashGet(`subscriber:${email}`);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.plan !== 'enterprise') {
      return res.status(403).json({ error: 'Editing questions is an Enterprise feature.' });
    }
    if (account.subscriptionStatus === 'canceled') {
      return res.status(403).json({ error: 'Subscription canceled' });
    }

    const propsKey = `subscriber-properties:${email}`;
    const properties = await upstashGet(propsKey) || [];
    const idx = properties.findIndex(p => p.id === propertyId);
    if (idx === -1) return res.status(404).json({ error: 'Property not found' });
    const prop = properties[idx];

    // A property that already has a set but no version number is on version 1.
    const currentVersion = prop.querySetVersion || (prop.queries?.length ? 1 : 0);

    if (Array.isArray(prop.queries) && prop.queries.length && setKey(prop.queries) === setKey(queries)) {
      return res.json({ success: true, changed: false, querySetVersion: currentVersion, querySetId: prop.querySetId });
    }

    const now = Date.now();
    const querySetId = querySetFingerprint(queries);
    const querySetVersion = currentVersion + 1;
    const history = Array.isArray(prop.querySetHistory) ? prop.querySetHistory : [];
    history.unshift({
      version: querySetVersion,
      querySetId,
      at: now,
      count: queries.length,
      source: source === 'generated' ? 'generated' : 'edited',
      previousQueries: prop.queries || [],
    });
    if (history.length > 20) history.length = 20;

    properties[idx] = {
      ...prop,
      queries,
      querySetId,
      querySetVersion,
      querySetAt: now,
      querySetHistory: history,
    };
    await upstashSet(propsKey, properties);

    res.json({ success: true, changed: true, querySetVersion, querySetId });
  } catch (err) {
    console.error('sub-update-queries error:', err.message);
    res.status(500).json({ error: 'Could not save your questions' });
  }
};

module.exports.validate = validate;
module.exports.setKey = setKey;
