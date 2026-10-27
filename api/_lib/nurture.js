// api/_lib/nurture.js
// Follow-up email series for people who run a free check.
//
// A completed free check enrolls the visitor (enroll). A daily Vercel cron
// (api/nurture-cron.js) sends whichever step is due. The series stops when the
// person unsubscribes, becomes a customer, or reaches the last step.
//
// Redis keys
//   nurture:{email}        JSON state: { step, enrolledAt, nextAt, lead, stopped }
//   nurture:due            sorted set, member = email, score = when the next step is due
//   nurture:unsub:{email}  set when someone unsubscribes (never expires)
//
// Env
//   RESEND_API_KEY           required to send
//   NURTURE_POSTAL_ADDRESS   required by CAN-SPAM; nothing sends without it
//   NURTURE_FROM             optional, default "Citro <audit@getcitro.ai>"
//   NURTURE_REPLY_TO         optional, default LEAD_NOTIFY_EMAIL
//   JWT_SECRET               signs unsubscribe links

const https = require('https');
const crypto = require('crypto');

const DAY = 24 * 60 * 60 * 1000;
// Days after the free check that each step goes out. Step 0 is the results
// email, sent by free-check.js the moment the check finishes.
const SCHEDULE = [2, 5, 9, 14];
const SITE = 'https://getcitro.ai';

async function upstash(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}
const getJSON = async key => { const r = await upstash(['GET', key]); try { return r.result ? JSON.parse(r.result) : null; } catch { return null; } };

const norm = e => String(e || '').trim().toLowerCase();
const token = email => crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-secret-change-me').update('unsub:' + norm(email)).digest('hex').slice(0, 32);
const validToken = (email, t) => {
  const a = Buffer.from(token(email)), b = Buffer.from(String(t || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const unsubUrl = email => `${SITE}/api/unsubscribe?e=${encodeURIComponent(norm(email))}&t=${token(email)}`;

// Addresses Eric uses for testing. They can still be sent a test from the
// admin page, but are never enrolled from the lead list in bulk.
const isTestAddress = e => /^emdalton\+|@example\.com$|^test@/i.test(e);

// ── Enrollment ───────────────────────────────────────────────────────────────
// lead: { email, domain, company, category, location, score, named, answered, competitors[], id }
async function enroll(lead, { now = Date.now(), firstAt } = {}) {
  const email = norm(lead.email);
  if (!email || !process.env.UPSTASH_REDIS_REST_URL) return { enrolled: false, reason: 'no-storage' };
  const [unsub, sub, existing] = await Promise.all([
    upstash(['EXISTS', `nurture:unsub:${email}`]),
    upstash(['EXISTS', `subscriber:${email}`]),
    getJSON(`nurture:${email}`),
  ]);
  if (unsub.result) return { enrolled: false, reason: 'unsubscribed' };
  if (sub.result) return { enrolled: false, reason: 'customer' };
  const keep = { email, domain: lead.domain, company: lead.company, category: lead.category, location: lead.location,
                 score: lead.score, named: lead.named, answered: lead.answered, competitors: (lead.competitors || []).slice(0, 5), id: lead.id };
  if (existing) {
    // A repeat check refreshes the details the emails quote, without restarting the series.
    await upstash(['SET', `nurture:${email}`, JSON.stringify({ ...existing, lead: keep })]);
    return { enrolled: false, reason: 'already-enrolled' };
  }
  const nextAt = firstAt || now + SCHEDULE[0] * DAY;
  const state = { step: 0, enrolledAt: now, nextAt, lead: keep, stopped: null };
  await Promise.all([
    upstash(['SET', `nurture:${email}`, JSON.stringify(state)]),
    upstash(['ZADD', 'nurture:due', nextAt, email]),
  ]);
  return { enrolled: true };
}

async function unsubscribe(email) {
  email = norm(email);
  const state = await getJSON(`nurture:${email}`);
  await Promise.all([
    upstash(['SET', `nurture:unsub:${email}`, String(Date.now())]),
    upstash(['ZREM', 'nurture:due', email]),
    state ? upstash(['SET', `nurture:${email}`, JSON.stringify({ ...state, stopped: 'unsubscribed', nextAt: null })]) : null,
  ]);
}

// ── Content ──────────────────────────────────────────────────────────────────
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const utm = (url, step) => url + (url.includes('?') ? '&' : '?') + `utm_source=nurture&utm_medium=email&utm_campaign=free_check_followup&utm_content=step${step}`;

function links(l, step) {
  const starter = `${SITE}/start.html?plan=starter&em=${encodeURIComponent(l.email)}&co=${encodeURIComponent(l.company || '')}&url=${encodeURIComponent(l.domain || '')}`;
  return {
    results: utm(l.id ? `${SITE}/free-check.html?id=${encodeURIComponent(l.id)}` : `${SITE}/free-check.html`, step),
    recheck: utm(`${SITE}/free-check.html`, step),
    starter: utm(starter, step),
    sample: utm(`${SITE}/sample-audit.html`, step),
  };
}

const listJoin = a => a.length <= 1 ? (a[0] || '') : a.length === 2 ? `${a[0]} and ${a[1]}` : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
const place = l => (l.location && !/all of the us/i.test(l.location)) ? ` in ${l.location}` : '';
const market = l => l.category ? `${l.category}${place(l)}` : 'your market';

// Each step returns { subject, paragraphs[], cta:{label,url}, after[] }.
// Paragraph strings are plain text; **bold** marks are turned into <strong>.
function buildStep(step, l, extra = {}) {
  const k = links(l, step);
  const company = l.company || l.domain || 'your business';
  const comps = (l.competitors || []).filter(Boolean);
  const c1 = comps[0];
  const missed = !l.named;

  if (step === 1) {
    return {
      subject: c1 ? `Why AI recommends ${c1} ${missed ? `instead of ${company}` : 'more often'}` : `How AI decides which ${l.category || 'business'} to recommend`,
      paragraphs: [
        c1
          ? `When we checked ${l.domain}, ChatGPT and Gemini named ${listJoin(comps.slice(0, 2))} when someone asked about ${market(l)}. ${missed ? `${company} didn't come up in any of the ${l.answered || 6} answers.` : `${company} came up in ${l.named} of ${l.answered}.`}`
          : `When we checked ${l.domain}, ${missed ? `${company} didn't come up in any of the answers` : `${company} came up in ${l.named} of ${l.answered} answers`} from ChatGPT and Gemini.`,
        `AI assistants don't rank websites the way Google does. They build an answer from what other sites say about a business. Three things usually decide who gets named:`,
        `**1. Mentions on sites the assistant trusts.** Directories, review sites, "best of" lists and local news.`,
        `**2. Pages that say plainly what you do.** Who it's for, where you work and what it costs, in sentences an AI can quote.`,
        `**3. Signs you're active.** Recent reviews, updated pages and current listings.`,
        `${c1 ? `${c1} is most likely ahead on the first one. ` : ''}It's also the fastest gap to close. This week, search for "best ${l.category || 'your service'}${place(l)}" and note the lists and directories that come up. Make sure ${company} is on each one.`,
      ],
      cta: { label: 'See your results again', url: k.results },
      after: [`The full audit shows exactly which sites each assistant reads for ${market(l)}, across five assistants. <a href="${k.starter}">Get it for $29</a>.`],
    };
  }

  if (step === 2) {
    const own = l.domain || '';
    const srcs = (extra.sources || []).filter(d => d && d !== own && !d.endsWith('.' + own)).slice(0, 5);
    return {
      subject: 'The sites AI reads before it recommends anyone',
      paragraphs: srcs.length
        ? [
            `In your free check, ChatGPT and Gemini built their answers from these sites:`,
            ...srcs.map(d => `• ${d}`),
            `These are the sources to be on. If ${company} isn't listed, ask to be added; most directories and review sites take a short form. If you're listed but the profile is thin, fill it in: services, area served, photos and recent reviews.`,
          ]
        : [
            `In your free check, the assistants didn't cite many outside sites, which usually means they leaned on what they already "know" about ${market(l)}.`,
            `That knowledge comes from directories, review sites and roundup articles. The quickest way in is to make sure ${company} is listed on the main directories for your industry and on Google Business Profile, with a full description and recent reviews.`,
          ],
      cta: { label: 'Get the full audit for $29', url: k.starter },
      after: [`Your free check asked 3 questions on 2 assistants. The full audit asks the questions your customers ask on ChatGPT, Perplexity, Gemini, Claude and Grok, lists every site each one read, and turns it into a 90-day plan. <a href="${k.sample}">See a sample audit</a>.`],
    };
  }

  if (step === 3) {
    return {
      subject: `${company}'s full AI visibility audit, $29`,
      paragraphs: [
        `Your free check showed ${missed ? `that AI isn't recommending ${company} yet` : `where ${company} stands on two assistants`}. The full Citro audit shows why, and what to do about it:`,
        `• Your Citro Score on ChatGPT, Perplexity, Gemini, Claude and Grok`,
        `• Who gets named instead of you, question by question`,
        `• Every site the assistants read, so you know where to get listed`,
        `• A check of your website for what makes AI skip it`,
        `• A 90-day plan written for a small team`,
        `It's $29 a month for one full audit a month, and you can cancel anytime. If your first audit isn't useful, we refund the month.`,
      ],
      cta: { label: 'Get my full audit', url: k.starter },
      after: [`Not sure yet? <a href="${k.sample}">See a sample audit</a> first.`],
    };
  }

  if (step === 4) {
    return {
      subject: `Last note about ${company}'s AI visibility`,
      plain: true,
      paragraphs: [
        `Hi,`,
        `I've sent a few notes since you checked ${l.domain}. If getting recommended by AI isn't a priority right now, no problem. This is the last one.`,
        `If it is, two easy next steps:`,
        `• Re-run the free check to see if anything has changed: <a href="${k.recheck}">getcitro.ai/free-check</a>`,
        `• Get the full audit for $29, first month refundable: <a href="${k.starter}">start here</a>`,
        `Either way, if you have a question, just reply. A real person reads every one.`,
        `Eric<br>Citro`,
      ],
    };
  }
  return null;
}

function render(step, l, extra = {}) {
  // Build twice: once with HTML-escaped lead details for the HTML part, once
  // with the raw details for the plain-text part.
  const escLead = { ...l, company: esc(l.company), domain: esc(l.domain), category: esc(l.category), location: esc(l.location),
                    competitors: (l.competitors || []).map(esc) };
  const escExtra = { ...extra, sources: (extra.sources || []).map(esc) };
  const s = buildStep(step, escLead, escExtra);
  const raw = buildStep(step, l, extra);
  if (!s) return null;
  const addr = process.env.NURTURE_POSTAL_ADDRESS || '';
  const unsub = unsubUrl(l.email);
  const bold = t => t.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#07202B;">$1</strong>');
  const footer = `You're getting this because you ran a free check at getcitro.ai. <a href="${unsub}" style="color:#7E959F;">Unsubscribe</a>.<br>RootPartners LLC${addr ? ', ' + esc(addr) : ''}`;
  const link = t => t.replace(/<a href="/g, '<a style="color:#026F8B;font-weight:600;" href="');
  const p = t => `<p style="font-size:15px;color:#48626E;line-height:1.65;margin:0 0 14px;">${link(bold(t))}</p>`;

  const body = s.plain
    ? `<div style="max-width:560px;margin:24px auto;padding:0 16px;font-family:Inter,system-ui,sans-serif;">${s.paragraphs.map(p).join('')}
<p style="font-size:12px;color:#7E959F;line-height:1.6;margin:28px 0 0;">${footer}</p></div>`
    : `<div style="max-width:540px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #D7E7ED;">
<div style="background:#07202B;padding:24px 32px;"><span style="font-size:20px;font-weight:800;color:#00BDE7;">Citro</span></div>
<div style="padding:32px;">
${s.paragraphs.map(p).join('\n')}
${s.cta ? `<p style="margin:22px 0 24px;"><a href="${s.cta.url}" style="display:inline-block;background:#00BDE7;color:#04222E;padding:12px 22px;border-radius:999px;font-size:14px;font-weight:700;text-decoration:none;">${esc(s.cta.label)}</a></p>` : ''}
${(s.after || []).map(p).join('\n')}
<p style="font-size:12px;color:#7E959F;line-height:1.6;margin:24px 0 0;">${footer}</p>
</div></div>`;
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${s.plain ? '#fff' : '#F2F8FA'};font-family:Inter,system-ui,sans-serif;">${body}</body></html>`;

  const toText = t => t.replace(/<br>/g, '\n').replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2 ($1)').replace(/<[^>]+>/g, '').replace(/\*\*/g, '');
  const text = [
    ...raw.paragraphs.map(toText),
    raw.cta ? `${raw.cta.label}: ${raw.cta.url}` : '',
    ...(raw.after || []).map(toText),
    '',
    `You're getting this because you ran a free check at getcitro.ai. Unsubscribe: ${unsub}`,
    `RootPartners LLC${addr ? ', ' + addr : ''}`,
  ].filter(Boolean).join('\n\n');

  return { subject: raw.subject, html, text, unsub };
}

// ── Sending ──────────────────────────────────────────────────────────────────
function sendEmail({ to, subject, html, text, unsub }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return Promise.resolve({ ok: false, error: 'RESEND_API_KEY is not set' });
  const reply = process.env.NURTURE_REPLY_TO || process.env.LEAD_NOTIFY_EMAIL;
  const payload = JSON.stringify({
    from: process.env.NURTURE_FROM || 'Citro <audit@getcitro.ai>',
    to: [to], subject, html, text,
    ...(reply ? { reply_to: reply } : {}),
    headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  });
  return new Promise(resolve => {
    const req = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST', timeout: 10000,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, r => {
      let body = ''; r.on('data', c => { body += c; });
      r.on('end', () => {
        if (r.statusCode >= 300) { console.error('nurture resend', r.statusCode, body.slice(0, 300)); resolve({ ok: false, error: `Resend ${r.statusCode}: ${body.slice(0, 200)}` }); }
        else resolve({ ok: true });
      });
    });
    req.on('error', e => { console.error('nurture resend failed:', e.message); resolve({ ok: false, error: e.message }); });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(payload); req.end();
  });
}

async function sourcesFor(lead) {
  if (!lead.id) return [];
  const r = await getJSON(`fc:result:${lead.id}`);
  return ((r && r.sources) || []).map(s => s.domain).filter(Boolean);
}

// Send the due step for one person and schedule the next. Returns what happened.
async function sendDue(email, now = Date.now()) {
  email = norm(email);
  const state = await getJSON(`nurture:${email}`);
  if (!state) { await upstash(['ZREM', 'nurture:due', email]); return 'missing'; }
  const [unsub, sub] = await Promise.all([upstash(['EXISTS', `nurture:unsub:${email}`]), upstash(['EXISTS', `subscriber:${email}`])]);
  const stop = async reason => {
    await Promise.all([upstash(['ZREM', 'nurture:due', email]), upstash(['SET', `nurture:${email}`, JSON.stringify({ ...state, stopped: reason, nextAt: null })])]);
    return reason;
  };
  if (unsub.result) return stop('unsubscribed');
  if (sub.result) return stop('customer');
  const step = (state.step || 0) + 1;
  if (step > SCHEDULE.length) return stop('finished');

  const extra = step === 2 ? { sources: await sourcesFor(state.lead) } : {};
  const msg = render(step, { ...state.lead, email }, extra);
  const sent = await sendEmail({ to: email, ...msg });
  if (!sent.ok) {
    // Try again tomorrow; give up after three failures so a bad address doesn't loop forever.
    const fails = (state.fails || 0) + 1;
    if (fails >= 3) { await upstash(['SET', `nurture:${email}`, JSON.stringify({ ...state, fails })]); return stop('send-failed'); }
    await Promise.all([upstash(['SET', `nurture:${email}`, JSON.stringify({ ...state, fails })]), upstash(['ZADD', 'nurture:due', now + DAY, email])]);
    return 'retry';
  }
  const nextAt = step < SCHEDULE.length ? state.enrolledAt + SCHEDULE[step] * DAY : null;
  // If a step ran late (for example, a backfilled lead), keep at least two days between emails.
  const next = nextAt ? Math.max(nextAt, now + 2 * DAY) : null;
  const updated = { ...state, step, lastSentAt: now, nextAt: next, fails: 0, stopped: next ? null : 'finished' };
  await upstash(['SET', `nurture:${email}`, JSON.stringify(updated)]);
  if (next) await upstash(['ZADD', 'nurture:due', next, email]); else await upstash(['ZREM', 'nurture:due', email]);
  return 'sent';
}

module.exports = { SCHEDULE, DAY, enroll, unsubscribe, validToken, unsubUrl, render, sendEmail, sendDue, sourcesFor, isTestAddress, norm, upstash, getJSON };
