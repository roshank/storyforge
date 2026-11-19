import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeScene, heuristicScene, buildStoryPrompt, buildTranslatePrompt, countWords, KINDS, SETTINGS, MAX_CHARACTERS,
} from '../public/js/shared/prompts.js';

test('normalizeScene keeps valid model output', () => {
  const s = normalizeScene({ setting: 'ocean', time: 'dusk', characters: [{ name: 'Finn', kind: 'fish', color: 'teal' }] });
  assert.deepEqual(s, { setting: 'ocean', time: 'dusk', characters: [{ name: 'Finn', kind: 'fish', color: 'teal' }] });
});

test('normalizeScene parses JSON wrapped in prose and repairs bad values', () => {
  const raw = 'Sure! {"setting":"jungle","time":"midnight","characters":[{"name":"Rex","kind":"dinosaur","color":"chartreuse"}]} hope that helps';
  const s = normalizeScene(raw, 'Rex the dinosaur walked in the forest');
  assert.equal(s.setting, 'forest');
  assert.equal(s.time, 'night');
  assert.equal(s.characters[0].kind, 'dragon');
  assert.equal(s.characters[0].color, 'green');
});

test('normalizeScene clamps character count and falls back on garbage', () => {
  const many = { setting: 'space', time: 'night', characters: Array.from({ length: 9 }, (_, i) => ({ name: `C${i}`, kind: 'robot', color: 'gray' })) };
  assert.equal(normalizeScene(many).characters.length, MAX_CHARACTERS);
  const s = normalizeScene('not json at all', 'A bunny on the beach by the ocean waves');
  assert.equal(s.setting, 'ocean');
  assert.equal(s.characters[0].kind, 'bunny');
});

test('heuristicScene always returns something drawable', () => {
  const s = heuristicScene('');
  assert.ok(SETTINGS.includes(s.setting));
  assert.ok(s.characters.length >= 1);
  assert.ok(s.characters.every((c) => KINDS.includes(c.kind)));
});

test('prompts include the premise, age, and target language', () => {
  const p = buildStoryPrompt({ premise: 'a shy dragon', age: 4, length: 'medium' });
  assert.match(p, /shy dragon/);
  assert.match(p, /4-year-old/);
  assert.match(p, /400 words/);
  assert.match(buildTranslatePrompt('Hi', 'ja'), /Japanese/);
  assert.equal(countWords(' one two  three\n'), 3);
});
