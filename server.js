// Story Forge dev server.
// - Serves the static app from ./public (Chrome's built-in AI needs a secure
//   context; http://localhost counts).
// - Exposes /api/cloud/* so the cloud engine can run side by side with the
//   on-device one. The API key stays on this server; the browser never sees it.
//   Prompts are built here from the shared module, so the endpoint can't be used
//   as a general-purpose proxy.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  STORY_SYSTEM, buildStoryPrompt, TITLE_SYSTEM, buildTitlePrompt, buildTranslatePrompt,
  SCENE_SYSTEM, buildScenePrompt, SCENE_SCHEMA, normalizeScene, LANGUAGES,
} from './public/js/shared/prompts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, 'public');
const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '127.0.0.1';
const MODEL = process.env.STORYFORGE_CLOUD_MODEL ?? 'claude-opus-5-5';
const EFFORT = process.env.STORYFORGE_CLOUD_EFFORT ?? 'low';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

let client = null;
function getClient() {
  // The SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profiles.
  client ??= new Anthropic();
  return client;
}
export function setClientForTests(c) { client = c; }

function baseParams(system, maxTokens) {
  return {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    output_config: { effort: EFFORT },
    // Re-run on a fallback model if a safety classifier declines.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
}

async function readJson(req, limit = 64_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}

/** Stream text deltas as NDJSON: {"t":"..."} lines, then {"done":true,...} or {"error":"..."}. */
async function streamText(res, params) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const send = (o) => res.write(JSON.stringify(o) + '\n');
  try {
    const stream = getClient().beta.messages.stream(params);
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') send({ t: event.delta.text });
    }
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') send({ error: 'The cloud model declined this story idea. Try a different one!' });
    else send({ done: true, model: msg.model, usage: msg.usage });
  } catch (err) {
    send({ error: describeError(err) });
  }
  res.end();
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Cloud engine: invalid or missing API key (set ANTHROPIC_API_KEY and restart).';
  if (err instanceof Anthropic.RateLimitError) return 'Cloud engine: rate limited, try again shortly.';
  if (err instanceof Anthropic.APIError) return `Cloud engine error ${err.status ?? ''}: ${err.message}`;
  if (/credential|api key|apiKey|authToken/i.test(String(err?.message))) return 'Cloud engine: no API key configured (set ANTHROPIC_API_KEY and restart).';
  return `Cloud engine: ${err?.message ?? err}`;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/cloud/status' && req.method === 'GET') {
    const configured = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE || client);
    return json(res, 200, { model: MODEL, effort: EFFORT, configured });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const body = await readJson(req);

  switch (url.pathname) {
    case '/api/cloud/story':
      return streamText(res, {
        ...baseParams(STORY_SYSTEM, 4000),
        messages: [{ role: 'user', content: buildStoryPrompt(body) }],
      });
    case '/api/cloud/title':
      return streamText(res, {
        ...baseParams(TITLE_SYSTEM, 200),
        messages: [{ role: 'user', content: buildTitlePrompt(clip(body.story)) }],
      });
    case '/api/cloud/translate': {
      if (!LANGUAGES.some((l) => l.code === body.target)) return json(res, 400, { error: 'Unsupported language' });
      return streamText(res, {
        ...baseParams('You are a careful translator of children\'s stories.', 6000),
        messages: [{ role: 'user', content: buildTranslatePrompt(clip(body.story), body.target) }],
      });
    }
    case '/api/cloud/scene': {
      const story = clip(body.story);
      try {
        const msg = await getClient().beta.messages.create({
          ...baseParams(SCENE_SYSTEM, 2000),
          output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCENE_SCHEMA } },
          messages: [{ role: 'user', content: buildScenePrompt(story) }],
        });
        const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        return json(res, 200, { scene: normalizeScene(text, story), usage: msg.usage });
      } catch (err) {
        return json(res, 502, { error: describeError(err) });
      }
    }
    default:
      return json(res, 404, { error: 'Not found' });
  }
}

const clip = (s) => String(s ?? '').slice(0, 12_000);

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function serveStatic(res, url) {
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'Forbidden' });
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await serveStatic(res, url);
    } catch (err) {
      if (!res.headersSent) json(res, err.status ?? 500, { error: err.message });
      else res.end();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, HOST, () => {
    console.log(`Story Forge running at http://localhost:${PORT}`);
    console.log(`Cloud engine: ${MODEL} (effort ${EFFORT})${process.env.ANTHROPIC_API_KEY ? '' : ' — no ANTHROPIC_API_KEY set; cloud mode will report an error'}`);
  });
}
