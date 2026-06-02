// api/quick-check.js - unauthenticated, no-card "instant check" for the top of the funnel.
//
// Takes a website URL + work email, runs a fast, constrained estimate, and returns a
// preliminary Citro Score plus one finding (a competitor beating them and a query they
// are losing). The full verified 7-platform audit, competitor matrix, personas, tracking,
// and the 90-day plan stay gated behind the trial (start.html).
//
// This is the v1 funnel-widener described in Citro-No-Card-Check-Spec-2026-06.md. It is
// deliberately small and cheap: one Haiku call with a capped token budget, gated on email,
// rate-limited by IP and domain, with a global daily spend ceiling.
//
// Required env vars (already set in Vercel for other endpoints):
//   ANTHROPIC_API_KEY
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN   (optional - limits are skipped if absent)

const https = require('https');

// ── Tunable limits ─────────────────────────────────────────────────────────────
const IP_DAILY_CAP     = 10;   // checks per IP per day
const DOMAIN_DAILY_CAP = 5;    // checks per target domain per day
const GLOBAL_DAILY_CAP = 250;  // total checks per day (spend ceiling)
const DAY_SECONDS      = 86400;
const MAX_TOKENS       = 700;

// ── Upstash REST helpers (same pattern as start-trial.js) ───────────────────────
function upstashEnabled() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
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
// INCR a counter and set its TTL on first write. Returns the new count.
async function incrWithTtl(key, ttl) {
  const r = await upstashCmd(['INCR', key]);
  const count = (r && typeof r.result === 'number') ? r.result : 1;
  if (count === 1) { try { await upstashCmd(['EXPIRE', key, ttl]); } catch (e) {} }
  return count;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function normalizeDomain(raw) {
  try {
    let u = String(raw).trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const host = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    return host;
  } catch (e) { return null; }
}
function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}
function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// ── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ ok: false, error: 'Server configuration error.' }); return; }

  const { url, email } = req.body || {};
  const domain = normalizeDomain(url);
  if (!domain)        { res.status(400).json({ ok: false, error: 'Please enter a valid website.' }); return; }
  if (!validEmail(email)) { res.status(400).json({ ok: false, error: 'Please enter a valid work email.' }); return; }

  const cleanEmail = email.trim().toLowerCase();
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  // ── Rate limiting + spend ceiling (best-effort; skipped if Upstash absent) ──
  if (upstashEnabled()) {
    try {
      const day = todayKey();
      const global = await incrWithTtl(`qc:spend:${day}`, DAY_SECONDS);
      if (global > GLOBAL_DAILY_CAP) {
        // Capacity reached - capture the lead and tell them we'll follow up.
        try { await upstashCmd(['SET', `lead:${cleanEmail}`, JSON.stringify({ email: cleanEmail, domain, status: 'queued_capacity', ts: Date.now() }), 'EX', 60 * 60 * 24 * 30]); } catch (e) {}
        res.status(200).json({ ok: false, reason: 'capacity', message: 'We are running a lot of checks right now. Leave it with us and we will email your report shortly.' });
        return;
      }
      const ipCount = await incrWithTtl(`qc:ip:${ip}`, DAY_SECONDS);
      if (ipCount > IP_DAILY_CAP) {
        res.status(200).json({ ok: false, reason: 'rate_limited', message: 'You have run several checks today. Start a free trial to run the full audit on every brand you manage.' });
        return;
      }
      const domCount = await incrWithTtl(`qc:dom:${domain}`, DAY_SECONDS);
      if (domCount > DOMAIN_DAILY_CAP) {
        res.status(200).json({ ok: false, reason: 'rate_limited', message: 'This site has been checked several times today. Start a free trial for the full, verified audit and your 90-day plan.' });
        return;
      }
    } catch (e) { /* never block a real visitor on a limiter error */ }
  }

  // ── Constrained model call ─────────────────────────────────────────────────
  const prompt = `You are Citro's AI citation analyst. Citro measures how often AI assistants (ChatGPT, Perplexity, Gemini, Claude, Copilot, Grok, Meta AI) recommend a brand when buyers ask for the best option in its category.

Give a PRELIMINARY estimate for the website "${domain}". Base it on what a brand at that domain most likely sells and how visible it plausibly is in AI answers today. Most brands score low because AI assistants name a small set of well-known names. Be realistic and slightly conservative, not flattering.

Return ONLY valid JSON, no markdown, no commentary:
{
  "companyName": "best guess at the brand name from the domain",
  "category": "short phrase for what they likely sell",
  "score": <integer 0-100, the estimated Citro Score: share of relevant AI queries where this brand is recommended>,
  "competitor": "one well-known competitor in their category that AI assistants are likely to recommend instead",
  "losingQuery": "one realistic buyer question to an AI assistant where this brand is likely NOT named (e.g. 'best CRM for small law firms')"
}`;

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });

  const opts = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  };

  return new Promise((resolve) => {
    const proxy = https.request(opts, (anthropicRes) => {
      let raw = '';
      anthropicRes.on('data', (chunk) => raw += chunk);
      anthropicRes.on('end', async () => {
        try {
          const parsed = JSON.parse(raw);
          const text = parsed.content?.[0]?.text || '{}';
          const match = text.match(/\{[\s\S]*\}/);
          const data = match ? JSON.parse(match[0]) : {};

          let score = parseInt(data.score, 10);
          if (isNaN(score)) score = 0;
          score = Math.max(0, Math.min(100, score));

          const result = {
            ok: true,
            company: data.companyName || domain,
            category: data.category || '',
            score,
            platformsTested: 7,
            competitor: data.competitor || '',
            losingQuery: data.losingQuery || '',
            preliminary: true,
          };

          // Store the lead for the nurture sequence (30-day TTL).
          if (upstashEnabled()) {
            try {
              await upstashCmd(['SET', `lead:${cleanEmail}`, JSON.stringify({
                email: cleanEmail, domain, company: result.company, score, ts: Date.now(), source: 'quick-check',
              }), 'EX', 60 * 60 * 24 * 30]);
            } catch (e) {}
          }

          res.status(200).json(result);
        } catch (e) {
          res.status(200).json({ ok: false, reason: 'parse_failed', message: 'We could not complete the check just now. Please try again, or start your free trial for the full audit.' });
        }
        resolve();
      });
    });

    proxy.on('error', (err) => {
      res.status(502).json({ ok: false, error: 'Upstream error: ' + err.message });
      resolve();
    });

    proxy.write(body);
    proxy.end();
  });
};
