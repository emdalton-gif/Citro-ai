// api/research.js
// Pre-purchase company research — no auth required.
// Takes company basics from step 1 and returns suggested values for step 2.
// If a website URL is provided, fetches and reads the page content for accuracy.

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Fetch a URL, following one redirect, returning raw text (max 80 KB)
function fetchUrl(rawUrl, redirectCount = 0) {
  return new Promise((resolve) => {
    if (redirectCount > 3) { resolve(''); return; }
    let parsed;
    try { parsed = new URL(rawUrl); } catch { resolve(''); return; }
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RootPartners-Research/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 8000,
    };
    const req = lib.request(options, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        resolve(fetchUrl(next, redirectCount + 1));
        return;
      }
      let raw = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size < 80000) raw += chunk;
      });
      res.on('end', () => resolve(raw));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

// Strip HTML tags and collapse whitespace, returning readable text (max ~6 KB)
function extractText(html) {
  // Remove scripts, styles, and nav/footer clutter
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text.slice(0, 6000);
}

async function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing API key');

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const options = {
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
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.content?.[0]?.text || '');
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { name, website, industry, specific_product } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing company name' });

  // Fetch and read website if provided
  let websiteContent = '';
  if (website) {
    const url = website.startsWith('http') ? website : `https://${website}`;
    try {
      const html = await fetchUrl(url);
      if (html) websiteContent = extractText(html);
    } catch { /* non-fatal */ }
  }

  const productCtx = specific_product
    ? `The specific product or service being audited: ${specific_product}.`
    : '';
  const webCtx = websiteContent
    ? `\n\nWebsite content (use this as the primary source):\n${websiteContent}`
    : website
      ? `\nTheir website: ${website} (could not be fetched — use your knowledge).`
      : '';

  try {
    const raw = await callClaude(
      `You are researching a company to pre-fill an AI visibility audit intake form. Use the website content below as your primary source of truth. Only fall back to general knowledge if the website content is insufficient.\n\nCompany: ${name}\nIndustry: ${industry || 'not specified'}\n${productCtx}${webCtx}\n\nReturn ONLY a JSON object with these exact keys — no explanation, no markdown:\n{\n  "summary": "2-3 sentences describing exactly what this company does, their specific focus area, and who their clients are. Be precise — not generic.",\n  "industry": "Their specific niche in 3-6 words (e.g. 'AI marketing consulting', 'B2B sales enablement SaaS', 'healthcare revenue cycle management') — be precise, not broad",\n  "offer": "1-2 sentence description of what they sell and who they target — be specific about the product/service and customer profile",\n  "buyer": "Job title, company type, and buying context of their most likely buyer — 1-2 sentences",\n  "geo": "Geographic market (e.g. United States, North America, Global) — keep it short",\n  "competitors": "4-6 likely direct competitors as a comma-separated list — company names only, no descriptions"\n}\n\nIf you cannot confidently fill a field from the available information, return an empty string. Do not invent or hallucinate specific facts.`
    );

    const cleaned = raw.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    const result = JSON.parse(cleaned.slice(start, end + 1));

    res.json(result);
  } catch(err) {
    console.error('research error:', err.message);
    res.json({ offer: '', buyer: '', geo: '', competitors: '' });
  }
};
