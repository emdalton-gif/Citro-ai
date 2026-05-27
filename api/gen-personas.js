// api/gen-personas.js — unauthenticated persona generation for pre-signup flow
// Used by start.html step 4 before the user has a session token.
// Low-risk: generates buyer personas from public profile data only.

const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'Server configuration error.' }); return; }

  const { company_name, offer, buyer, industry, geo, competitors } = req.body || {};
  if (!company_name) { res.status(400).json({ error: 'company_name is required.' }); return; }

  const prompt = `Generate exactly 3 realistic buyer personas for ${company_name}.
What they sell: ${offer || 'not specified'}
Target buyer: ${buyer || 'not specified'}
Industry: ${industry || 'not specified'}
Geography: ${geo || 'not specified'}
Key competitors: ${competitors || 'not specified'}

Return ONLY a valid JSON array — no markdown, no explanation:
[
  {
    "name": "First Last",
    "title": "Job title",
    "company": "Company type and size",
    "painPoint": "1-2 sentences: the main challenge this company solves for them",
    "searchBehavior": "1 sentence: how they use AI to find vendors or solutions"
  }
]`;

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 900,
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
      anthropicRes.on('data', chunk => raw += chunk);
      anthropicRes.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const text = parsed.content?.[0]?.text || '[]';
          const match = text.match(/\[[\s\S]*\]/);
          const personas = match ? JSON.parse(match[0]) : [];
          if (!personas.length) throw new Error('empty');
          res.status(200).json({ personas });
        } catch(e) {
          res.status(200).json({ personas: [], error: 'parse_failed' });
        }
        resolve();
      });
    });

    proxy.on('error', (err) => {
      res.status(502).json({ error: 'Upstream error: ' + err.message });
      resolve();
    });

    proxy.write(body);
    proxy.end();
  });
};
