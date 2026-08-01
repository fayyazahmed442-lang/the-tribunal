// The Tribunal — single-file server for Replit.
// Serves index.html and proxies /api/verdict so the API key stays on the server.
// Put your key in Replit's "Secrets" panel as ANTHROPIC_API_KEY.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const SEVERITY_NOTE = {
  light:
    'Keep it gentle and affectionate — the kind of teasing a close friend does. Land soft.',
  medium:
    'Sharp and funny. Real observations, real punchlines, but they should laugh, not flinch.',
  brutal:
    'Go hard and relentless — but funny-hard, like a professional roast set. Still never cruel about things they cannot change.'
};

function buildPrompt(mode, severity) {
  const modeLine =
    mode === 'roast'
      ? 'ROAST — a stand-up comedy roast. Punchy, absurd, exaggerated, laugh-out-loud. Prioritize jokes over accuracy.'
      : 'JUDGE — a mock formal ruling. Deadpan legal register applied to trivial life choices, which is what makes it funny. Drier wit than the roast.';

  return `You are The Tribunal: a mock court that delivers comedic verdicts on people who submit themselves as evidence.

MODE: ${modeLine}

SEVERITY: ${SEVERITY_NOTE[severity] || SEVERITY_NOTE.medium}

Rules that never bend:
- Roast the CHOICES, HABITS and CONTRADICTIONS the person describes. That is where the comedy is.
- Never mock appearance, weight, race, ethnicity, religion, nationality, disability, gender, sexuality, income, or intelligence.
- Never touch anything that reads as genuine distress, illness, grief, or self-harm. If the submission contains that, drop the bit entirely: return a warm, sincere, non-joking response instead and set the stamp to "COURT ADJOURNED".
- The target should want to screenshot this and send it to their group chat.
- Specific beats generic. Quote their own details back at them.

Reply with ONLY a raw JSON object, no markdown fences, no preamble:
{
  "stamp": "2-4 word all-caps verdict, punchy, e.g. GUILTY OF BEING BUSY",
  "opinion": "2-4 sentences. The main roast or ruling.",
  "charges": ["three separate one-line charges, each its own joke"],
  "sentence": "one funny line describing their punishment",
  "score": 7
}
"score" is 1-10, how the court rates them overall. Do not include any other keys.`;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// --- simple in-memory rate limit: 10 verdicts per IP per hour ---
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < hour);
  if (list.length >= 10) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}

async function handleVerdict(req, res) {
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';

  if (rateLimited(ip)) {
    return json(res, 429, {
      error: 'The court has heard enough from you today. Try again later.'
    });
  }

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20000) {
      return json(res, 413, { error: 'Evidence is too long.' });
    }
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: 'Malformed request.' });
  }

  const { evidence, mode = 'roast', severity = 'medium' } = payload;

  if (typeof evidence !== 'string' || !evidence.trim()) {
    return json(res, 400, { error: 'No evidence submitted.' });
  }
  if (evidence.length > 4000) {
    return json(res, 400, { error: 'Evidence is too long. Keep it under 4000 characters.' });
  }
  if (!['roast', 'judge'].includes(mode)) {
    return json(res, 400, { error: 'Unknown mode.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(res, 500, {
      error: 'Server is missing ANTHROPIC_API_KEY. Add it in the Secrets panel.'
    });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: buildPrompt(mode, severity) + '\n\nEXHIBIT A:\n' + evidence.trim()
          }
        ]
      })
    });

    if (!upstream.ok) {
      console.error('Anthropic error', upstream.status, await upstream.text());
      return json(res, 502, { error: 'The bench is unavailable right now.' });
    }

    const data = await upstream.json();
    const text = (data.content || [])
      .filter((i) => i.type === 'text')
      .map((i) => i.text)
      .join('\n')
      .replace(/```json|```/g, '')
      .trim();

    let verdict;
    try {
      verdict = JSON.parse(text);
    } catch {
      return json(res, 502, { error: 'The bench returned an unreadable ruling.' });
    }

    return json(res, 200, verdict);
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: 'Something went wrong reaching the bench.' });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/verdict') {
    return handleVerdict(req, res);
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    return fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      if (err) {
        res.writeHead(500);
        return res.end('Could not load index.html');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`The Tribunal is in session on port ${PORT}`);
});
