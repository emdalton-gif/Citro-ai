// api/sub-save-run.js
// Saves a completed audit run to the subscriber's history and sends email report.
// Called by sub-audit.html after the audit completes client-side.

const crypto = require('crypto');
const https = require('https');

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

function sendRunCompleteEmail(toEmail, companyName, runId, overallScore) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return Promise.resolve();

  const resultUrl = `https://getcitro.ai/sub-dashboard.html`;
  const scoreColor = overallScore < 40 ? '#DC2626' : overallScore < 65 ? '#D97706' : '#059669';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:Inter,system-ui,sans-serif;">
  <div style="max-width:540px;margin:48px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E2E8F0;">
    <div style="background:#0B0F1A;padding:28px 36px;">
      <span style="font-size:18px;font-weight:700;color:#fff;">Root</span><span style="font-size:18px;font-weight:800;color:#2563EB;">ACE</span>
      <span style="font-size:13px;color:rgba(255,255,255,0.4);margin-left:12px;">Active Optimization</span>
    </div>
    <div style="padding:36px;">
      <p style="font-size:20px;font-weight:700;color:#0B0F1A;margin:0 0 8px;">Your audit is ready${companyName ? ` — ${companyName}` : ''}.</p>
      ${overallScore !== undefined ? `<p style="font-size:14px;color:#64748B;margin:0 0 24px;">Citro Score: <strong style="color:${scoreColor};font-size:18px;">${overallScore}%</strong></p>` : '<div style="margin-bottom:24px;"></div>'}
      <p style="font-size:15px;color:#64748B;line-height:1.7;margin:0 0 24px;">Your latest Citro report has finished running. Log in to your dashboard to view the full results, compare with previous runs, and see what changed.</p>
      <a href="${resultUrl}" style="display:inline-block;background:#2563EB;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;margin-bottom:24px;">View Results →</a>
      <p style="font-size:13px;color:#94A3B8;line-height:1.7;margin:0;">Questions? Reply to this email or reach us at <a href="mailto:support@rootpartners.co" style="color:#2563EB;">support@rootpartners.co</a></p>
    </div>
  </div>
</body>
</html>`;

  const payload = JSON.stringify({
    from: 'Citro <audit@getcitro.ai>',
    to: [toEmail],
    subject: `Your Citro audit is ready${companyName ? ` — ${companyName}` : ''}`,
    html,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, () => { resolve(); });
    req.on('error', () => resolve());
    req.write(payload);
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
  const email = verifySubscriberToken(token);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  const { results, profile, personas, propertyId } = req.body;
  if (!results) return res.status(400).json({ error: 'Missing results' });

  try {
    // Check subscription is active
    const account = await upstashGet(`subscriber:${email}`);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.subscriptionStatus === 'canceled') {
      return res.status(403).json({ error: 'Subscription canceled' });
    }

    const isEnterprise = account.plan === 'enterprise';
    const runId = crypto.randomBytes(12).toString('hex');
    const now = Date.now();

    // Save full results
    await upstashSet(`subscriber-run:${runId}`, {
      runId,
      email,
      results,
      profile,
      personas: personas || [],
      propertyId: propertyId || null,
      createdAt: now,
    });

    const summary = {
      runId,
      createdAt: now,
      companyName: profile?.company_name || '',
      overallScore: results?.overallScore ?? null,
    };

    if (isEnterprise && propertyId) {
      // ── Enterprise: save per-property run history + update property stats ──
      const perPropertyKey = `subscriber-runs:${email}:${propertyId}`;
      const propRuns = await upstashGet(perPropertyKey) || [];
      propRuns.unshift(summary);
      if (propRuns.length > 50) propRuns.length = 50;

      // Update property stats in-place
      const properties = await upstashGet(`subscriber-properties:${email}`) || [];
      const propIdx = properties.findIndex(p => p.id === propertyId);
      if (propIdx !== -1) {
        properties[propIdx].lastScore = results?.overallScore ?? null;
        properties[propIdx].lastRunAt = now;
        properties[propIdx].runCount = (properties[propIdx].runCount || 0) + 1;
        // Persist personas on property for apples-to-apples reruns
        if (personas && personas.length > 0) {
          properties[propIdx].personas = personas;
        }
      }

      await Promise.all([
        upstashSet(perPropertyKey, propRuns),
        upstashSet(`subscriber-properties:${email}`, properties),
      ]);
    } else {
      // ── Professional: existing profile-lock logic ──
      const existingProfile = await upstashGet(`subscriber-profile:${email}`);
      const isFirstRun = !existingProfile?.profileLocked;
      if (profile) {
        const profileToSave = { ...profile, updatedAt: now };
        if (isFirstRun) {
          profileToSave.profileLocked = true;
          profileToSave.lockedCompanyName = profile.company_name || '';
          profileToSave.lockedWebsite = profile.website || '';
        } else {
          profileToSave.profileLocked = true;
          profileToSave.lockedCompanyName = existingProfile.lockedCompanyName || existingProfile.company_name || '';
          profileToSave.lockedWebsite = existingProfile.lockedWebsite || existingProfile.website || '';
        }
        if (personas && personas.length > 0) {
          profileToSave.personas = personas;
        } else if (existingProfile?.personas) {
          profileToSave.personas = existingProfile.personas;
        }
        await upstashSet(`subscriber-profile:${email}`, profileToSave);
      }

      // Prepend to Professional run history list (keep last 50)
      const runs = await upstashGet(`subscriber-runs:${email}`) || [];
      runs.unshift(summary);
      if (runs.length > 50) runs.length = 50;
      await upstashSet(`subscriber-runs:${email}`, runs);
    }

    // Send completion email (non-blocking)
    sendRunCompleteEmail(email, profile?.company_name || '', runId, results?.overallScore).catch(() => {});

    res.json({ runId, success: true });
  } catch (err) {
    console.error('sub-save-run error:', err.message);
    res.status(500).json({ error: 'Could not save run' });
  }
};
