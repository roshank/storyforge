// Cloud engine: talks to the local server, which calls Claude. Everything here is
// counted by the privacy ledger.
import { egressFetch } from '../privacy.js';
import { normalizeScene } from '../shared/prompts.js';

export async function cloudStatus() {
  try {
    const r = await fetch('/api/cloud/status');
    if (!r.ok) throw new Error();
    return await r.json();
  } catch {
    return { configured: false, model: null, unreachable: true };
  }
}

async function* ndjson(response) {
  if (!response.ok && response.headers.get('content-type')?.includes('json')) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

async function* streamTask(what, path, payload, signal) {
  const res = await egressFetch(what, path, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  for await (const msg of ndjson(res)) {
    if (msg.error) throw new Error(msg.error);
    if (msg.t) yield msg.t;
  }
}

export const cloudEngine = {
  id: 'cloud',
  label: 'Cloud',
  storyStream: (opts, signal) => streamTask('Story (cloud)', '/api/cloud/story', opts, signal),
  translateStream: (story, target, signal) => streamTask('Translation (cloud)', '/api/cloud/translate', { story, target }, signal),
  async title(story, signal) {
    let out = '';
    for await (const t of streamTask('Title (cloud)', '/api/cloud/title', { story }, signal)) out += t;
    return out.trim().replace(/^["']|["']$/g, '');
  },
  async scene(story, signal) {
    const res = await egressFetch('Scene (cloud)', '/api/cloud/scene', {
      method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ story }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return normalizeScene(body.scene, story);
  },
};
