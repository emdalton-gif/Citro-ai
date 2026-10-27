// api/admin-leads.js
// Free-check leads for the admin, newest first. Each completed free check is
// pushed to the Redis list fc:leads by api/free-check.js; checks that hit the
// daily capacity are queued on fc:queued and listed separately.
// Requires a valid admin token (from api/admin-auth.js) in Authorization.

const crypto = require('crypto');
const N = require('./_lib/nurture');

function verifyAdminToken(token) {
  if (!token) return false;
  try {
    const { p: payload, s: sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
    const parts = payload.split(':');
    if (parts.length !== 2 || parts[0] !== 'admin') return false;
    return Date.now() <= parseInt(parts[1], 10);
  } catch { return false; }
}

async function upstash(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}

const parse = list => (Array.isArray(list) ? list : []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

async function nurtureStatus(emails) {
  const uniq = [...new Set(emails.map(N.norm).filter(Boolean))];
  if (!uniq.length) return {};
  const [states, unsubs] = await Promise.all([
    upstash(['MGET', ...uniq.map(e => `nurture:${e}`)]),
    upstash(['MGET', ...uniq.map(e => `nurture:unsub:${e}`)]),
  ]);
  const out = {};
  uniq.forEach((e, i) => {
    let st = null; try { st = states.result?.[i] ? JSON.parse(states.result[i]) : null; } catch {}
    out[e] = {
      enrolled: !!st, sent: st ? st.step || 0 : 0, of: N.SCHEDULE.length, nextAt: st?.nextAt || null,
      stopped: unsubs.result?.[i] ? 'unsubscribed' : (st?.stopped || null),
    };
  });
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const auth = req.headers['authorization'] || '';
  if (!verifyAdminToken(auth.startsWith('Bearer ') ? auth.slice(7) : null)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (!process.env.UPSTASH_REDIS_REST_URL) { res.status(500).json({ error: 'Lead storage is not configured' }); return; }

  if (req.method === 'POST') {
    const b = req.body || {};
    try {
      const all = parse((await upstash(['LRANGE', 'fc:leads', 0, 499])).result);
      // Send every step of the series to one address, filled in with a real
      // lead's details, so the emails can be checked before anyone gets them.
      if (b.action === 'test') {
        const to = N.norm(b.to);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) { res.status(400).json({ error: 'Enter a valid address to send the test to' }); return; }
        const lead = all.find(l => l.id === b.leadId) || all.find(l => !N.isTestAddress(l.email)) || all[0];
        if (!lead) { res.status(400).json({ error: 'No leads to build a test from' }); return; }
        const sources = await N.sourcesFor(lead);
        const sent = [];
        for (let step = 1; step <= N.SCHEDULE.length; step++) {
          const msg = N.render(step, { ...lead, email: to }, step === 2 ? { sources } : {});
          const r = await N.sendEmail({ to, ...msg, subject: `[Test ${step} of ${N.SCHEDULE.length}] ${msg.subject}` });
          sent.push({ step, subject: msg.subject, ok: r.ok, error: r.error });
        }
        res.status(200).json({ ok: sent.every(x => x.ok), basedOn: lead.company, sent });
        return;
      }
      // Enroll leads from before the series existed. dryRun lists who would be added.
      if (b.action === 'enroll-existing') {
        const seen = new Set(), picks = [];
        for (const l of all) {
          const e = N.norm(l.email);
          if (!e || seen.has(e) || N.isTestAddress(e)) continue;
          seen.add(e); picks.push(l);
        }
        const status = await nurtureStatus(picks.map(l => l.email));
        const todo = picks.filter(l => { const st = status[N.norm(l.email)]; return st && !st.enrolled && !st.stopped; });
        if (b.dryRun) { res.status(200).json({ ok: true, wouldEnroll: todo.map(l => ({ email: l.email, company: l.company })) }); return; }
        const now = Date.now(), results = [];
        // The first email goes out on the next daily run, the rest on the usual spacing.
        for (const l of todo) results.push({ email: l.email, ...(await N.enroll(l, { now: now - N.SCHEDULE[0] * N.DAY, firstAt: now })) });
        res.status(200).json({ ok: true, enrolled: results.filter(r => r.enrolled).length, results });
        return;
      }
      res.status(400).json({ error: 'Unknown action' });
    } catch (e) {
      console.error('admin-leads action failed', e.message);
      res.status(500).json({ error: 'That action failed' });
    }
    return;
  }

  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '200', 10) || 200));
  try {
    const [done, queued] = await Promise.all([
      upstash(['LRANGE', 'fc:leads', 0, limit - 1]),
      upstash(['LRANGE', 'fc:queued', 0, limit - 1]),
    ]);
    const leads = parse(done.result);
    let nurture = {};
    try { nurture = await nurtureStatus(leads.map(l => l.email)); } catch {}
    res.status(200).json({
      leads,
      queued: parse(queued.result),
      nurture,
      notify: { resend: !!process.env.RESEND_API_KEY, to: !!process.env.LEAD_NOTIFY_EMAIL },
      followups: { postalAddress: !!process.env.NURTURE_POSTAL_ADDRESS, replyTo: !!(process.env.NURTURE_REPLY_TO || process.env.LEAD_NOTIFY_EMAIL) },
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not read leads' });
  }
};
