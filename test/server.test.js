import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, setClientForTests } from '../server.js';

// A stand-in for the Anthropic client so tests never hit the network.
const calls = [];
const fakeClient = {
  beta: {
    messages: {
      stream(params) {
        calls.push(params);
        const text = params.messages[0].content.includes('title') ? 'The Sleepy Fox' : 'Once upon a time.\n\nThe end.';
        return {
          async *[Symbol.asyncIterator]() {
            for (const piece of text.match(/.{1,6}/gs)) yield { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } };
          },
          finalMessage: async () => ({ stop_reason: 'end_turn', model: params.model, usage: { output_tokens: 7 } }),
        };
      },
      async create(params) {
        calls.push(params);
        return { content: [{ type: 'text', text: JSON.stringify({ setting: 'meadow', time: 'night', characters: [{ name: 'Pip', kind: 'mouse', color: 'gray' }] }) }], usage: {} };
      },
    },
  },
};

let server, base;
before(async () => {
  setClientForTests(fakeClient);
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function ndjson(res) {
  return (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
}

test('serves the app and blocks path traversal', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Story Forge/);
  const shared = await fetch(`${base}/js/shared/prompts.js`);
  assert.match(shared.headers.get('content-type'), /javascript/);
  const bad = await fetch(`${base}/..%2fserver.js`);
  assert.notEqual(bad.status, 200);
});

test('story endpoint streams NDJSON built from the shared prompt', async () => {
  const res = await fetch(`${base}/api/cloud/story`, { method: 'POST', body: JSON.stringify({ premise: 'a sleepy fox', age: 6 }) });
  const lines = await ndjson(res);
  assert.equal(lines.filter((l) => l.t).map((l) => l.t).join(''), 'Once upon a time.\n\nThe end.');
  assert.ok(lines.at(-1).done);
  const p = calls.at(-1);
  assert.match(p.system, /bedtime storyteller/);
  assert.match(p.messages[0].content, /sleepy fox/);
  assert.equal(p.fallbacks, 'default');
});

test('scene endpoint uses structured output and normalizes', async () => {
  const res = await fetch(`${base}/api/cloud/scene`, { method: 'POST', body: JSON.stringify({ story: 'Pip the mouse' }) });
  const body = await res.json();
  assert.equal(body.scene.characters[0].kind, 'mouse');
  assert.equal(calls.at(-1).output_config.format.type, 'json_schema');
});

test('translate rejects unknown languages', async () => {
  const res = await fetch(`${base}/api/cloud/translate`, { method: 'POST', body: JSON.stringify({ story: 'x', target: 'xx' }) });
  assert.equal(res.status, 400);
});
