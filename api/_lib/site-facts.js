// api/_lib/site-facts.js
// Looks at a customer's website the way an AI crawler would, so the report
// only recommends what the site is actually missing. Not an endpoint: Vercel
// does not deploy files under directories that start with "_".
//
// Why this exists: on 2026-10-06 a customer was told to create an llms.txt
// they already had (two of them). The report had never looked at the site.
// Every site-level claim in a report must now come from these facts.

const dns = require('dns').promises;
const net = require('net');

// Browser-style user agent that still names us. Many sites behind bot
// protection turn away anything that doesn't look like a browser.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 CitroSiteCheck/1.0 (+https://getcitro.ai)';
const FETCH_TIMEOUT_MS = 7000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// The crawlers that decide whether a site can be read by AI assistants.
const AI_BOTS = [
  { token: 'GPTBot',            who: 'OpenAI training' },
  { token: 'OAI-SearchBot',     who: 'ChatGPT search' },
  { token: 'ChatGPT-User',      who: 'ChatGPT browsing' },
  { token: 'PerplexityBot',     who: 'Perplexity' },
  { token: 'ClaudeBot',         who: 'Anthropic' },
  { token: 'Claude-SearchBot',  who: 'Claude search' },
  { token: 'Google-Extended',   who: 'Gemini' },
  { token: 'Googlebot',         who: 'Google Search and AI Overviews' },
  { token: 'Bingbot',           who: 'Bing and Copilot' },
  { token: 'Applebot-Extended', who: 'Apple Intelligence' },
];

// ── Safety: never fetch private or internal addresses ────────────────────────
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') ||
    v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') ||
    v.startsWith('::ffff:192.168.') || v.startsWith('::ffff:169.254.');
}

const hostOk = new Map();
async function assertPublicHost(hostname) {
  if (hostOk.has(hostname)) { if (!hostOk.get(hostname)) throw new Error('blocked host'); return; }
  let ok = false;
  try {
    if (net.isIP(hostname)) ok = !isPrivateIp(hostname);
    else if (/^(localhost|.*\.local|.*\.internal)$/i.test(hostname)) ok = false;
    else {
      const addrs = await dns.lookup(hostname, { all: true });
      ok = addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address));
    }
  } catch { ok = false; }
  hostOk.set(hostname, ok);
  if (!ok) throw new Error('blocked host');
}

// Fetch with manual redirects so every hop is checked, a hard timeout, and a
// size cap. Returns { ok, status, url, type, text } or { ok:false, error }.
async function getText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  let current = url;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = new URL(current);
      if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'bad protocol', url: current };
      await assertPublicHost(u.hostname);
      const r = await fetch(current, {
        redirect: 'manual', signal: ctrl.signal,
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8' },
      });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        current = new URL(r.headers.get('location'), current).toString();
        continue;
      }
      const type = (r.headers.get('content-type') || '').toLowerCase();
      // Read up to MAX_BYTES so a huge file can't stall the function.
      const reader = r.body && r.body.getReader ? r.body.getReader() : null;
      let text = '';
      if (reader) {
        const chunks = []; let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length; chunks.push(value);
          if (size > MAX_BYTES) { try { await reader.cancel(); } catch {} break; }
        }
        text = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
      } else {
        text = await r.text();
      }
      const server = (r.headers.get('server') || '').toLowerCase();
      const protection = r.headers.get('cf-ray') || server.includes('cloudflare') ? 'Cloudflare'
        : (r.headers.get('x-sucuri-id') || server.includes('sucuri')) ? 'Sucuri'
        : server.includes('akamai') || r.headers.get('akamai-grn') ? 'Akamai'
        : r.headers.get('x-amz-cf-id') ? 'Amazon CloudFront' : null;
      return { ok: r.ok, status: r.status, url: current, type, text, protection };
    }
    return { ok: false, error: 'too many redirects', url: current };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch failed'), url: current };
  } finally {
    clearTimeout(timer);
  }
}

// ── Parsers (pure, unit-tested) ──────────────────────────────────────────────

function looksLikeHtml(text) {
  return /^\s*(<!doctype html|<html|<head|<body|<\?xml[^>]*>\s*<html)/i.test(text || '');
}

// A real llms.txt is plain text or markdown. Many sites answer every unknown
// path with their HTML 404 page and a 200 status, so status alone lies.
function parseLlms(res) {
  // Only a 404/410 proves absence. A 403 or a timeout is usually bot
  // protection, and saying "missing" then would repeat the original mistake.
  if (!res || !res.ok) return { status: res && (res.status === 404 || res.status === 410) ? 'missing' : 'unknown', httpStatus: res ? res.status || null : null, error: res && res.error };
  const text = res.text || '';
  if (looksLikeHtml(text) || text.trim().length < 20) return { status: 'missing', httpStatus: res.status, note: 'URL returns a web page, not a text file' };
  const lines = text.split(/\r?\n/).filter(l => l.trim()).length;
  const links = (text.match(/\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g) || []).length;
  const words = (text.match(/\S+/g) || []).length;
  const title = (text.match(/^\s*#\s+(.+)$/m) || [])[1] || null;
  return { status: 'present', url: res.url, httpStatus: res.status, lines, links, words, title: title && title.trim().slice(0, 120) };
}

// robots.txt: group lines by user-agent, then decide for each AI crawler
// whether the site root is allowed (Google's longest-match rule).
function parseRobots(text) {
  const groups = []; let cur = null; let lastWasAgent = false;
  const sitemaps = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim();
    if (key === 'sitemap') { if (val) sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') cur.rules.push({ type: key, path: val });
  }
  const groupFor = (token) => {
    const t = token.toLowerCase();
    const exact = groups.filter(g => g.agents.includes(t));
    if (exact.length) return { rules: exact.flatMap(g => g.rules), matched: token };
    const star = groups.filter(g => g.agents.includes('*'));
    return { rules: star.flatMap(g => g.rules), matched: star.length ? '*' : null };
  };
  const matchLen = (pattern, path) => {
    if (pattern === '') return -1;
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    return re.test(path) ? pattern.length : -1;
  };
  const access = (rules, path) => {
    let best = { len: -1, allow: true };
    for (const r of rules) {
      const len = matchLen(r.path, path);
      if (len < 0) continue;
      const allow = r.type === 'allow';
      if (len > best.len || (len === best.len && allow)) best = { len, allow };
    }
    return best.allow;
  };
  const bots = {};
  for (const b of AI_BOTS) {
    const g = groupFor(b.token);
    const rootAllowed = access(g.rules, '/');
    const hasPartial = g.rules.some(r => r.type === 'disallow' && r.path && r.path !== '/' && r.path !== '/*');
    bots[b.token] = { status: !rootAllowed ? 'blocked' : (hasPartial ? 'partial' : 'allowed'), group: g.matched, who: b.who };
  }
  return { sitemaps, bots };
}

function extractLocs(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, '&'));
}

// Every schema.org @type in a page's JSON-LD (including @graph) and microdata.
function extractSchemaTypes(html) {
  const types = new Set();
  const add = (t) => { (Array.isArray(t) ? t : [t]).forEach(x => { if (typeof x === 'string' && x) types.add(x.replace(/^https?:\/\/schema\.org\//i, '')); }); };
  const walk = (node, depth = 0) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
    if (typeof node !== 'object') return;
    if (node['@type']) add(node['@type']);
    for (const k of Object.keys(node)) if (k !== '@context') walk(node[k], depth + 1);
  };
  const blocks = [...String(html || '').matchAll(/<script[^>]+type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)];
  let parseErrors = 0;
  for (const b of blocks) {
    const body = b[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').replace(/^\s*\/\/.*$/gm, '').trim();
    try { walk(JSON.parse(body)); } catch { parseErrors++; }
  }
  for (const m of String(html || '').matchAll(/itemtype\s*=\s*["']https?:\/\/schema\.org\/([A-Za-z]+)["']/gi)) types.add(m[1]);
  return { types: [...types], blocks: blocks.length, parseErrors };
}

function pageMeta(html) {
  const h = String(html || '');
  const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const robotsMeta = (h.match(/<meta[^>]+name\s*=\s*["']robots["'][^>]*>/i) || [])[0] || '';
  const canonical = (h.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i) || [])[1] || null;
  return {
    title: title ? title.replace(/\s+/g, ' ').trim().slice(0, 160) : null,
    noindex: /content\s*=\s*["'][^"']*noindex/i.test(robotsMeta),
    canonical,
  };
}

// Links from the homepage to a help center, FAQ or support site on the same
// domain or a subdomain of it (help.example.com, support.example.com/faq).
function helpSiteLinks(html, baseUrl) {
  const base = new URL(baseUrl).hostname.replace(/^www\./, '');
  const out = new Set();
  for (const m of String(html || '').matchAll(/<a[^>]+href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], baseUrl);
      const h = u.hostname.replace(/^www\./, '');
      const sameSite = h === base || h.endsWith('.' + base);
      if (!sameSite || !/^https?:$/.test(u.protocol)) continue;
      const sub = h === base ? '' : h.slice(0, -(base.length + 1));
      if (/(^|\.)(help|support|faq|faqs|docs|knowledge|kb|answers|customer)(\.|$)/i.test(sub) || (h !== base && /\/(faq|help|support)/i.test(u.pathname))) out.add(u.origin + (u.pathname === '/' ? '' : u.pathname));
    } catch {}
  }
  return [...out].slice(0, 5);
}

// Internal links on a page, used as a page inventory when there's no sitemap.
function internalLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const out = new Set();
  for (const m of String(html || '').matchAll(/<a[^>]+href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], base);
      if (u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '') && /^https?:$/.test(u.protocol)) {
        u.hash = ''; out.add(u.toString());
      }
    } catch {}
  }
  return [...out];
}

const PAGE_KINDS = {
  comparison:  /(^|[\/\-_])(vs|versus|compare|comparison|alternatives?)([\/\-_.]|$)/i,
  faq:         /(^|\/)(faqs?|frequently-asked(-questions)?|help-center|helpcenter|support|help)(\/|$)/i,
  pricing:     /(^|[\/\-_])(pricing|prices|plans)([\/\-_.]|$)/i,
  caseStudies: /(case-stud(y|ies)|customer-stor(y|ies)|success-stor(y|ies)|testimonials?)/i,
  about:       /(^|\/)(about|about-us|company|who-we-are)([\/\-_.]|$)/i,
  offering:    /(^|\/)(courses?|products?|programs?|training|services?|solutions?|platform|features?)(\/|$)/i,
  blog:        /(^|\/)(blog|news|articles?|insights|resources|posts?)(\/|$)/i,
};

function classifyUrls(urls) {
  const pages = {}; const counts = {};
  for (const k of Object.keys(PAGE_KINDS)) { pages[k] = []; counts[k] = 0; }
  for (const u of urls) {
    let path; try { path = new URL(u).pathname; } catch { continue; }
    for (const [k, re] of Object.entries(PAGE_KINDS)) {
      if (!re.test(path)) continue;
      // A blog post titled "conversations vs confrontations" is not a vendor
      // comparison page. Competitor coverage is checked against every path.
      if ((k === 'comparison' || k === 'faq' || k === 'pricing') && PAGE_KINDS.blog.test(path)) continue;
      counts[k]++; if (pages[k].length < 40) pages[k].push(u);
    }
  }
  return { pages, counts };
}

// ── The check ────────────────────────────────────────────────────────────────

function normalizeSite(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); return u.hostname.toLowerCase(); } catch { return null; }
}

async function findOrigin(host) {
  const tries = [`https://${host}/`];
  if (!host.startsWith('www.')) tries.push(`https://www.${host}/`); else tries.push(`https://${host.slice(4)}/`);
  tries.push(`http://${host}/`);
  let first = null;
  for (const t of tries) {
    const r = await getText(t);
    if (r.ok && r.text) { const u = new URL(r.url); return { origin: u.origin, home: r }; }
    if (!first) first = r;
  }
  // Keep why the homepage failed: a 403 from Cloudflare is bot protection,
  // not a site that's down, and the report should say which.
  return { origin: `https://${host}`, home: null, fail: first ? { status: first.status || null, error: first.error || null, protection: first.protection || null } : null };
}

// Sitemaps nest: an index can point at more indexes (cruciallearning.com goes
// sitemap.xml -> sitemap-index-1.xml -> page sitemaps). Walk up to three
// levels, skip image/video/news sitemaps, and count only real page URLs.
const MEDIA_SITEMAP = /(image|video|news)[-_]?sitemap|sitemap[-_]?(image|video|news)/i;
const sameSite = (a, b) => { try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); } catch { return false; } };

async function readSitemaps(origin, robotsSitemaps) {
  const candidates = [...new Set([...robotsSitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`])]
    .filter(u => sameSite(u, origin) && !MEDIA_SITEMAP.test(u));
  const urls = new Set(); let found = null; let truncated = false; let fetches = 0;
  const MAX_FETCHES = 30;
  const pagePriority = u => (/(page|post|course|product|service|program|solution)/i.test(u) ? 0 : 1);

  for (const cand of candidates.slice(0, 5)) {
    const r = await getText(cand); fetches++;
    if (!r.ok || !/<(urlset|sitemapindex)/i.test(r.text || '')) continue;
    found = r.url;
    let level = [r];
    for (let depth = 0; depth < 3 && level.length; depth++) {
      const next = [];
      for (const doc of level) {
        const locs = extractLocs(doc.text);
        if (/<sitemapindex/i.test(doc.text)) {
          next.push(...locs.filter(u => sameSite(u, origin) && !MEDIA_SITEMAP.test(u)));
        } else {
          locs.forEach(u => { if (urls.size < 25000 && !/\.xml(\.gz)?$/i.test(u)) urls.add(u); });
        }
      }
      if (!next.length) break;
      const ordered = [...new Set(next)].sort((a, b) => pagePriority(a) - pagePriority(b));
      const room = Math.max(0, MAX_FETCHES - fetches);
      if (ordered.length > room) truncated = true;
      const batch = ordered.slice(0, room);
      fetches += batch.length;
      level = (await Promise.all(batch.map(u => getText(u)))).filter(x => x.ok && /<(urlset|sitemapindex)/i.test(x.text || ''));
    }
    break;
  }
  return { url: found, urls: [...urls], truncated };
}

async function wikidataFor(brand, host) {
  if (!brand) return { status: 'unknown' };
  const api = 'https://www.wikidata.org/w/api.php';
  const s = await getText(`${api}?action=wbsearchentities&origin=*&format=json&language=en&limit=7&search=${encodeURIComponent(brand)}`);
  if (!s.ok) return { status: 'unknown', error: s.error || s.status };
  let ids = [];
  try { ids = (JSON.parse(s.text).search || []).map(x => x.id).filter(Boolean); } catch { return { status: 'unknown' }; }
  if (!ids.length) return { status: 'missing' };
  const g = await getText(`${api}?action=wbgetentities&origin=*&format=json&props=claims|labels|descriptions&languages=en&ids=${ids.join('|')}`);
  if (!g.ok) return { status: 'unknown' };
  try {
    const ents = JSON.parse(g.text).entities || {};
    const bare = host.replace(/^www\./, '');
    for (const [id, e] of Object.entries(ents)) {
      const sites = ((e.claims && e.claims.P856) || []).map(c => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value).filter(Boolean);
      if (sites.some(w => { try { return new URL(w).hostname.replace(/^www\./, '') === bare; } catch { return false; } })) {
        return { status: 'present', id, label: e.labels && e.labels.en && e.labels.en.value, description: e.descriptions && e.descriptions.en && e.descriptions.en.value };
      }
    }
  } catch { return { status: 'unknown' }; }
  return { status: 'missing' };
}

async function checkSite(website, brand) {
  const host = normalizeSite(website);
  if (!host) return { ok: false, error: 'No website given' };
  const startedAt = Date.now();
  const facts = { version: 1, checkedAt: new Date().toISOString(), site: host, reachable: false };

  const { origin, home, fail } = await findOrigin(host);
  if (!home && fail) facts.homeError = fail;
  facts.origin = origin;
  facts.reachable = !!home;

  const [llms, llmsFull, robotsRes, wikidata] = await Promise.all([
    getText(`${origin}/llms.txt`),
    getText(`${origin}/llms-full.txt`),
    getText(`${origin}/robots.txt`),
    wikidataFor(brand, host),
  ]);
  facts.llms = parseLlms(llms);
  facts.llmsFull = parseLlms(llmsFull);
  facts.wikidata = wikidata;

  if (robotsRes.ok && !looksLikeHtml(robotsRes.text)) {
    facts.robots = { status: 'present', ...parseRobots(robotsRes.text) };
  } else if (robotsRes.status === 404 || (robotsRes.ok && looksLikeHtml(robotsRes.text))) {
    // No robots.txt means everything is allowed.
    facts.robots = { status: 'missing', sitemaps: [], bots: Object.fromEntries(AI_BOTS.map(b => [b.token, { status: 'allowed', group: null, who: b.who }])) };
  } else {
    facts.robots = { status: 'unknown', error: robotsRes.error || robotsRes.status };
  }

  if (home) {
    facts.homepage = { url: home.url, ...pageMeta(home.text), schema: extractSchemaTypes(home.text) };
  }

  const sm = await readSitemaps(origin, (facts.robots && facts.robots.sitemaps) || []);
  const homeLinks = home ? internalLinks(home.text, home.url) : [];
  // Help centers and FAQ sites often live on a subdomain (help.example.com)
  // that the main sitemap never lists. Count anything the homepage links to.
  facts.helpSites = home ? helpSiteLinks(home.text, home.url) : [];
  const inventory = sm.urls.length ? sm.urls : homeLinks;
  const cls = classifyUrls([...new Set([...inventory, ...homeLinks])]);
  facts.sitemap = { status: sm.url ? 'present' : (facts.reachable ? 'missing' : 'unknown'), url: sm.url, urlCount: sm.urls.length, truncated: sm.truncated };
  facts.pages = { source: sm.urls.length ? 'sitemap' : (homeLinks.length ? 'homepage links' : 'none'), inventoryCount: inventory.length, ...cls };
  // Every page path, so a recommendation like "write a Brand vs Rival page" can
  // be checked against pages that already exist. The report strips this list
  // before saving; it is only needed while the plan is being written.
  facts.paths = [...new Set([...inventory, ...homeLinks].map(u => { try { return new URL(u).pathname.toLowerCase(); } catch { return null; } }).filter(Boolean))].slice(0, 8000);

  // Schema on a sample of real pages: the homepage plus one of each kind.
  const sample = [];
  // For blog and case studies, sample an actual post, not the /blog/ index.
  const depth = u => { try { return new URL(u).pathname.split('/').filter(Boolean).length; } catch { return 0; } };
  const pick = (kind) => {
    const list = (cls.pages[kind] || []).filter(x => !sample.some(s => s.url === x));
    const u = (kind === 'blog' || kind === 'caseStudies') ? (list.find(x => depth(x) >= 2) || null) : list[0];
    if (u) sample.push({ kind, url: u });
  };
  // One of each kind, plus a second offering page and a blog post: markup
  // differs by template, and blog posts often carry Article markup that the
  // homepage doesn't. Claims like "add Article schema to your posts" need a post.
  ['offering', 'blog', 'caseStudies', 'pricing', 'faq', 'about', 'comparison', 'offering'].forEach(pick);
  const fetched = await Promise.all(sample.slice(0, 7).map(async s => {
    const r = await getText(s.url);
    return r.ok ? { kind: s.kind, url: r.url, types: extractSchemaTypes(r.text).types } : { kind: s.kind, url: s.url, error: r.error || r.status };
  }));
  const byPage = [];
  if (facts.homepage) byPage.push({ kind: 'homepage', url: facts.homepage.url, types: facts.homepage.schema.types });
  fetched.forEach(f => byPage.push(f));
  const checked = byPage.filter(p => !p.error);
  facts.schema = {
    status: checked.length ? 'checked' : 'unknown',
    pagesChecked: checked.length,
    types: [...new Set(checked.flatMap(p => p.types))].sort(),
    sampledKinds: [...new Set(checked.map(p => p.kind))],
    byPage,
  };

  facts.ms = Date.now() - startedAt;
  return { ok: true, facts };
}

module.exports = { helpSiteLinks, checkSite, parseLlms, parseRobots, extractSchemaTypes, extractLocs, classifyUrls, internalLinks, pageMeta, normalizeSite, isPrivateIp, AI_BOTS };
