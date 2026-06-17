// api/admin-subscribers.js
// Returns a summary of all subscribers for the admin dashboard.
// Requires a valid admin token in the Authorization header.

const crypto = require('crypto');

function verifyAdminToken(token) {
  if (!token) return false;
  try {
    const { p: payload, s: sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
    if (!payload.startsWith('admin:')) return false;
    const exp = parseInt(payload.split(':')[1], 10);
    return Date.now() <= exp;
  } catch { return false; }
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

async function upstashKeys(pattern) {
  const r = await upstashCmd(['KEYS', pattern]);
  return Array.isArray(r.result) ? r.result : [];
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Find all subscriber account keys
    const keys = await upstashKeys('subscriber:*');

    // Filter to only actual account keys (not subscriber-properties:* or subscriber-runs:*)
    const accountKeys = keys.filter(k => {
      const parts = k.split(':');
      // subscriber:{email} = 2 parts
      return parts.length === 2 && parts[0] === 'subscriber';
    });

    // Fetch all accounts in parallel
    const accounts = await Promise.all(
      accountKeys.map(async (key) => {
        const email = key.slice('subscriber:'.length);
        const account = await upstashGet(key);
        if (!account) return null;

        const isEnterprise = account.plan === 'enterprise';
        let properties = [];
        let runCount = 0, lastRunAt = null, lastScore = null;
        if (isEnterprise) {
          properties = (await upstashGet(`subscriber-properties:${email}`)) || [];
          for (const p of properties) {
            runCount += (p.runCount || 0);
            if (p.lastRunAt && (!lastRunAt || new Date(p.lastRunAt).getTime() > new Date(lastRunAt).getTime())) {
              lastRunAt = p.lastRunAt;
              lastScore = (p.lastScore != null ? p.lastScore : null);
            }
          }
        } else {
          const runs = (await upstashGet(`subscriber-runs:${email}`)) || [];
          runCount = runs.length;
          if (runs.length) {
            lastRunAt = runs[0].createdAt || null;
            lastScore = (runs[0].overallScore != null ? runs[0].overallScore : null);
          }
        }

        return {
          email,
          plan: account.plan || 'professional',
          status: account.status || 'active',
          createdAt: account.createdAt || null,
          runCount,
          lastRunAt,
          lastScore,
          company: account.company || null,
          website: account.website || null,
          // Enterprise-specific
          propertyCount: isEnterprise ? properties.length : null,
          properties: isEnterprise ? properties.map(p => ({
            id: p.id,
            name: p.name,
            website: p.website,
            runCount: p.runCount || 0,
            lastScore: p.lastScore || null,
            lastRunAt: p.lastRunAt || null,
          })) : null,
        };
      })
    );

    const valid = accounts.filter(Boolean).sort((a, b) => {
      // Sort by plan (enterprise first), then by most recent activity
      if (a.plan !== b.plan) return a.plan === 'enterprise' ? -1 : 1;
      const aTime = a.lastRunAt ? new Date(a.lastRunAt).getTime() : 0;
      const bTime = b.lastRunAt ? new Date(b.lastRunAt).getTime() : 0;
      return bTime - aTime;
    });

    res.json({
      total: valid.length,
      enterprise: valid.filter(s => s.plan === 'enterprise').length,
      professional: valid.filter(s => s.plan === 'professional').length,
      subscribers: valid,
    });
  } catch (err) {
    console.error('admin-subscribers error:', err.message);
    res.status(500).json({ error: 'Could not load subscribers' });
  }
};
