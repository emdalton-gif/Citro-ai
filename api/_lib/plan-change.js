// api/_lib/plan-change.js
// Shared by api/sub-upgrade.js and api/sub-webhook.js. Not an endpoint:
// Vercel does not deploy files under directories that start with "_".

const crypto = require('crypto');

// Which plan a Stripe price belongs to, or null for an unknown price.
function planForPrice(priceId) {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_ENTERPRISE_PRICE_ID) return 'enterprise';
  if (priceId === process.env.STRIPE_PROFESSIONAL_PRICE_ID || priceId === process.env.STRIPE_ACTIVE_PRICE_ID) return 'professional';
  return null;
}

// A Professional account keeps one business on its profile and its runs in
// subscriber-runs:{email}. Enterprise keeps each brand as a property with its
// own runs. On upgrade the business becomes the first property, carrying its
// question set, personas and score history, so nothing starts over.
// Safe to call more than once: it does nothing if a property already exists.
async function convertProfileToProperty(email, get, set) {
  const properties = await get(`subscriber-properties:${email}`) || [];
  if (properties.length) return { created: false, property: properties[0] };
  const profile = await get(`subscriber-profile:${email}`) || {};
  const runs = await get(`subscriber-runs:${email}`) || [];
  const name = profile.lockedCompanyName || profile.company_name || profile.name || '';
  const website = profile.lockedWebsite || profile.website || '';
  if (!name && !website && !runs.length) return { created: false, property: null };

  const id = crypto.randomBytes(12).toString('hex');
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const property = {
    id,
    name: name || website,
    website,
    industry: str(profile.industry),
    specific_product: str(profile.specific_product),
    offer: str(profile.offer),
    buyer: str(profile.buyer),
    geo: str(profile.geo),
    competitors: str(profile.competitors),
    brand_aliases: str(profile.brand_aliases),
    markets: Array.isArray(profile.markets) ? profile.markets.slice(0, 5) : undefined,
    personas: Array.isArray(profile.personas) ? profile.personas : [],
    queries: Array.isArray(profile.queries) && profile.queries.length ? profile.queries : undefined,
    querySetId: profile.querySetId,
    querySetVersion: profile.querySetVersion,
    querySetAt: profile.querySetAt,
    querySetHistory: profile.querySetHistory,
    createdAt: Date.now(),
    convertedFromProfessional: true,
    runCount: runs.length,
    lastScore: runs[0]?.overallScore ?? null,
    lastRunAt: runs[0]?.createdAt ?? null,
  };
  for (const k of Object.keys(property)) if (property[k] === undefined) delete property[k];

  await set(`subscriber-runs:${email}:${id}`, runs);
  await set(`subscriber-properties:${email}`, [property]);
  return { created: true, property };
}

module.exports = { planForPrice, convertProfileToProperty };
