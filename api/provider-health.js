// api/provider-health.js
// Admin-only check that every answering platform works end to end: the API
// key is valid, the configured model still exists, web search runs and
// sources come back. Open /provider-health.html (signed in as admin) after a
// deploy, or whenever a platform goes quiet in audits.
//
// Model IDs retire on every provider. Before this existed, a retired model
// failed silently inside customer reports; this surfaces it on your schedule.

const crypto = require('crypto');
const { CALLERS, MODELS, parseLocation } = require('./live-query.js');

function verifyAdminToken(token) {
  if (!token) return false;
  try {
    const { p: payload, s: sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
    if (!payload.startsWith('admin:')) return false;
    return Date.now() <= parseInt(payload.split(':')[1], 10);
  } catch { return false; }
}

const TEST_QUESTION = 'What are some well-reviewed coffee shops to work from, and where did you find them?';
const TEST_GEO = 'Grand Rapids, MI';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const loc = parseLocation(TEST_GEO);
  const results = await Promise.all(Object.entries(CALLERS).map(async ([platform, fn]) => {
    const started = Date.now();
    try {
      const r = await fn(TEST_QUESTION, loc, 90000);
      const ok = !!r.text && r.sources.length > 0;
      return {
        platform, ok, model: r.model,
        latency_ms: Date.now() - started,
        answer_chars: r.text.length,
        sources: r.sources.length,
        sample_sources: r.sources.slice(0, 3).map(s => s.domain || s.url),
        search_queries: r.searchQueries.slice(0, 3),
        location_applied: !!r.locationApplied,
        problem: ok ? null : (!r.text ? 'Empty answer' : 'Answered without citing any web sources (search may not have run)'),
      };
    } catch (err) {
      return { platform, ok: false, model: MODELS[platform], latency_ms: Date.now() - started, problem: err.message };
    }
  }));

  res.json({ checked_at: new Date().toISOString(), question: TEST_QUESTION, geo: TEST_GEO, all_ok: results.every(r => r.ok), results });
};
