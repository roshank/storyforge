// Shared by the browser (on-device engine) and the Node server (cloud engine),
// so both engines receive exactly the same instructions. Keep this file free of
// DOM and Node APIs.

export const LANGUAGES = [
  { code: 'es', name: 'Spanish', bcp47: 'es-ES' },
  { code: 'fr', name: 'French', bcp47: 'fr-FR' },
  { code: 'de', name: 'German', bcp47: 'de-DE' },
  { code: 'it', name: 'Italian', bcp47: 'it-IT' },
  { code: 'pt', name: 'Portuguese', bcp47: 'pt-BR' },
  { code: 'hi', name: 'Hindi', bcp47: 'hi-IN' },
  { code: 'ja', name: 'Japanese', bcp47: 'ja-JP' },
  { code: 'ko', name: 'Korean', bcp47: 'ko-KR' },
  { code: 'zh', name: 'Chinese (Simplified)', bcp47: 'zh-CN' },
];

export function languageName(code) {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

export const LENGTHS = {
  short: { label: 'Short (~2 min)', words: 220 },
  medium: { label: 'Medium (~4 min)', words: 400 },
};

export const STORY_SYSTEM = `You are Story Forge, a gentle bedtime storyteller for young children.
Rules:
- Warm, calm, cozy tone. Nothing scary, violent, or sad without a happy resolution.
- Simple words a young child understands; short sentences; a little gentle repetition is nice.
- Name the main characters early and keep them consistent.
- End with everyone safe, sleepy, and happy, winding down toward sleep.
- Output only the story: no title, no headings, no notes. Use 4 to 7 short paragraphs separated by blank lines.
- If the premise is not appropriate for a child, quietly turn it into a kind, safe story instead.`;

export function buildStoryPrompt({ premise, age = 5, length = 'short' }) {
  const words = (LENGTHS[length] ?? LENGTHS.short).words;
  const clean = String(premise ?? '').trim().slice(0, 500) || 'a sleepy little fox who finds a glowing star';
  return `Write a bedtime story for a ${age}-year-old, about ${words} words long.
The child's idea for the story: "${clean}"`;
}

export const TITLE_SYSTEM = 'You write short, sweet titles for children\'s bedtime stories.';
export function buildTitlePrompt(story) {
  return `Give this bedtime story a title of at most 6 words. Reply with the title only, no quotes.\n\n${story}`;
}

export function buildTranslatePrompt(story, targetCode) {
  return `Translate this children's bedtime story into ${languageName(targetCode)}. Keep the paragraph breaks exactly. Use simple words a young child understands. Reply with the translation only.\n\n${story}`;
}

// ---------------------------------------------------------------------------
// Scene description for the Wonder World renderer.

export const SETTINGS = ['forest', 'ocean', 'space', 'castle', 'meadow', 'mountains', 'desert', 'city'];
export const TIMES = ['night', 'dusk', 'day'];
export const KINDS = [
  'fox', 'bunny', 'bear', 'cat', 'owl', 'dragon', 'robot', 'fish',
  'unicorn', 'child', 'star', 'ghost', 'mouse', 'turtle',
];
export const COLORS = {
  orange: [0.98, 0.55, 0.22],
  red: [0.92, 0.3, 0.32],
  pink: [0.98, 0.62, 0.78],
  purple: [0.66, 0.5, 0.95],
  blue: [0.38, 0.62, 0.98],
  teal: [0.3, 0.8, 0.78],
  green: [0.45, 0.82, 0.42],
  yellow: [0.99, 0.85, 0.35],
  brown: [0.62, 0.43, 0.3],
  white: [0.95, 0.95, 0.97],
  gray: [0.62, 0.64, 0.7],
  black: [0.22, 0.22, 0.28],
};
export const MAX_CHARACTERS = 5;

export const SCENE_SCHEMA = {
  type: 'object',
  properties: {
    setting: { type: 'string', enum: SETTINGS },
    time: { type: 'string', enum: TIMES },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          color: { type: 'string', enum: Object.keys(COLORS) },
        },
        required: ['name', 'kind', 'color'],
        additionalProperties: false,
      },
    },
  },
  required: ['setting', 'time', 'characters'],
  additionalProperties: false,
};

export const SCENE_SYSTEM = 'You turn children\'s stories into a small scene description for an illustration. Reply with JSON only.';
export function buildScenePrompt(story) {
  return `Describe the main scene of this story as JSON with:
- "setting": one of ${SETTINGS.join(', ')}
- "time": one of ${TIMES.join(', ')}
- "characters": up to ${MAX_CHARACTERS} main characters, each {"name", "kind", "color"}.
  "kind" must be one of ${KINDS.join(', ')} (pick the closest match; use "child" for people).
  "color" must be one of ${Object.keys(COLORS).join(', ')}.

Story:
${story}`;
}

/** Validate and clamp whatever a model produced into a scene the renderer can draw. */
export function normalizeScene(raw, storyText = '') {
  let obj = raw;
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/);
    try { obj = m ? JSON.parse(m[0]) : null; } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') return heuristicScene(storyText);

  const setting = SETTINGS.includes(obj.setting) ? obj.setting : heuristicScene(storyText).setting;
  const time = TIMES.includes(obj.time) ? obj.time : 'night';
  const characters = (Array.isArray(obj.characters) ? obj.characters : [])
    .filter((c) => c && typeof c === 'object')
    .slice(0, MAX_CHARACTERS)
    .map((c, i) => {
      const kind = KINDS.includes(c.kind) ? c.kind : guessKind(`${c.kind} ${c.name}`) ?? 'child';
      return {
        name: String(c.name ?? '').trim().slice(0, 24) || `Friend ${i + 1}`,
        kind,
        color: Object.hasOwn(COLORS, c.color) ? c.color : defaultColor(kind),
      };
    });
  if (characters.length === 0) return { ...heuristicScene(storyText), setting, time };
  return { setting, time, characters };
}

const KIND_WORDS = {
  fox: ['fox'], bunny: ['bunny', 'rabbit', 'hare'], bear: ['bear', 'teddy', 'panda'],
  cat: ['cat', 'kitten', 'kitty', 'lion', 'tiger'], owl: ['owl', 'bird', 'parrot', 'penguin', 'duck'],
  dragon: ['dragon', 'dinosaur', 'dino'], robot: ['robot', 'bot'], fish: ['fish', 'whale', 'dolphin', 'octopus', 'mermaid'],
  unicorn: ['unicorn', 'horse', 'pony'], star: ['star', 'moon', 'comet'], ghost: ['ghost', 'cloud', 'spirit'],
  mouse: ['mouse', 'mice', 'hamster', 'squirrel'], turtle: ['turtle', 'tortoise', 'snail', 'frog'],
  child: ['girl', 'boy', 'kid', 'child', 'princess', 'prince', 'knight', 'astronaut', 'grandma', 'grandpa'],
};
const SETTING_WORDS = {
  ocean: ['ocean', 'sea', 'beach', 'underwater', 'wave', 'island'],
  space: ['space', 'planet', 'rocket', 'galaxy', 'astronaut', 'moon base'],
  castle: ['castle', 'kingdom', 'tower', 'palace', 'princess', 'knight'],
  mountains: ['mountain', 'snow', 'hill', 'cave'],
  desert: ['desert', 'sand', 'dune', 'camel'],
  city: ['city', 'town', 'street', 'building', 'train'],
  meadow: ['meadow', 'garden', 'field', 'farm', 'flower'],
  forest: ['forest', 'wood', 'tree', 'jungle'],
};

export function guessKind(text) {
  const t = String(text ?? '').toLowerCase();
  for (const [kind, words] of Object.entries(KIND_WORDS)) {
    if (words.some((w) => new RegExp(`\\b${w}`).test(t))) return kind;
  }
  return null;
}

function defaultColor(kind) {
  return { fox: 'orange', bunny: 'white', bear: 'brown', cat: 'gray', owl: 'brown', dragon: 'green',
    robot: 'gray', fish: 'teal', unicorn: 'pink', child: 'yellow', star: 'yellow', ghost: 'white',
    mouse: 'gray', turtle: 'green' }[kind] ?? 'purple';
}

/** No-model fallback: pick a setting and characters by keyword. */
export function heuristicScene(storyText) {
  const t = String(storyText ?? '').toLowerCase();
  let setting = 'forest';
  let best = 0;
  for (const [s, words] of Object.entries(SETTING_WORDS)) {
    const n = words.reduce((acc, w) => acc + (t.split(w).length - 1), 0);
    if (n > best) { best = n; setting = s; }
  }
  const time = /\b(sun|morning|noon|daytime)\b/.test(t) && !/\b(night|moon|stars?)\b/.test(t) ? 'day' : 'night';
  const characters = [];
  for (const [kind, words] of Object.entries(KIND_WORDS)) {
    if (characters.length >= 3) break;
    if (words.some((w) => new RegExp(`\\b${w}`).test(t))) {
      characters.push({ name: kind[0].toUpperCase() + kind.slice(1), kind, color: defaultColor(kind) });
    }
  }
  if (characters.length === 0) characters.push({ name: 'Little Fox', kind: 'fox', color: 'orange' });
  return { setting, time, characters };
}

export function countWords(text) {
  return (String(text ?? '').match(/\S+/g) ?? []).length;
}
