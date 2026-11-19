// On-device engine: Chrome's built-in AI (Gemini Nano via the Prompt API, plus the
// Summarizer and Translator APIs). Nothing here touches the network; the browser
// may download model weights once, which carries no user data.
import {
  STORY_SYSTEM, buildStoryPrompt, TITLE_SYSTEM, buildTitlePrompt,
  SCENE_SYSTEM, buildScenePrompt, SCENE_SCHEMA, normalizeScene,
} from '../shared/prompts.js';

const LM_LANGS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
const SUMMARIZER_OPTS = {
  type: 'headline', format: 'plain-text', length: 'short',
  sharedContext: 'A bedtime story for a young child.',
  expectedInputLanguages: ['en'], outputLanguage: 'en',
};

const g = globalThis;
const has = (name) => typeof g[name] === 'function' || typeof g[name] === 'object';

/** 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported' */
async function safeAvailability(fn) {
  try { return await fn(); } catch { return 'unavailable'; }
}

export async function onDeviceCapabilities(targetLang) {
  const caps = {
    prompt: has('LanguageModel') ? await safeAvailability(() => g.LanguageModel.availability(LM_LANGS)) : 'unsupported',
    summarizer: has('Summarizer') ? await safeAvailability(() => g.Summarizer.availability(SUMMARIZER_OPTS)) : 'unsupported',
    translator: 'unsupported',
  };
  if (has('Translator') && targetLang) {
    caps.translator = await safeAvailability(() => g.Translator.availability({ sourceLanguage: 'en', targetLanguage: targetLang }));
  }
  return caps;
}

function monitorFor(label, onProgress) {
  return (m) => m.addEventListener('downloadprogress', (e) => onProgress?.(label, e.loaded ?? 0));
}

/** Prompt API streams were cumulative in early Chrome builds and are deltas now; accept both. */
async function* deltas(stream) {
  let acc = '';
  for await (const chunk of stream) {
    const delta = acc && chunk.startsWith(acc) ? chunk.slice(acc.length) : chunk;
    acc += delta;
    if (delta) yield delta;
  }
}

async function newSession(system, signal, onProgress) {
  if (!has('LanguageModel')) throw new Error('The Prompt API (Gemini Nano) is not available in this browser. See the setup notes.');
  return g.LanguageModel.create({
    ...LM_LANGS,
    initialPrompts: [{ role: 'system', content: system }],
    monitor: monitorFor('Gemini Nano', onProgress),
    signal,
  });
}

export function createOnDeviceEngine({ onProgress } = {}) {
  const translators = new Map();

  async function getTranslator(target, signal) {
    if (!has('Translator')) throw new Error('The Translator API is not available in this browser.');
    if (!translators.has(target)) {
      const avail = await g.Translator.availability({ sourceLanguage: 'en', targetLanguage: target });
      if (avail === 'unavailable') throw new Error(`On-device translation to "${target}" isn't supported here.`);
      translators.set(target, g.Translator.create({
        sourceLanguage: 'en', targetLanguage: target, monitor: monitorFor(`Translator (en→${target})`, onProgress), signal,
      }).catch((e) => { translators.delete(target); throw e; }));
    }
    return translators.get(target);
  }

  return {
    id: 'ondevice',
    label: 'On-device',

    async *storyStream(opts, signal) {
      const session = await newSession(STORY_SYSTEM, signal, onProgress);
      try {
        yield* deltas(session.promptStreaming(buildStoryPrompt(opts), { signal }));
      } finally {
        session.destroy();
      }
    },

    async title(story, signal) {
      if (has('Summarizer') && (await safeAvailability(() => g.Summarizer.availability(SUMMARIZER_OPTS))) !== 'unavailable') {
        const summarizer = await g.Summarizer.create({ ...SUMMARIZER_OPTS, monitor: monitorFor('Summarizer', onProgress), signal });
        try {
          return (await summarizer.summarize(story, { signal })).trim().replace(/^["'#\s]+|["'.\s]+$/g, '');
        } finally {
          summarizer.destroy();
        }
      }
      const session = await newSession(TITLE_SYSTEM, signal, onProgress);
      try {
        return (await session.prompt(buildTitlePrompt(story), { signal })).trim().replace(/^["']|["']$/g, '');
      } finally {
        session.destroy();
      }
    },

    async *translateStream(story, target, signal) {
      const translator = await getTranslator(target, signal);
      const paragraphs = story.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      for (let i = 0; i < paragraphs.length; i++) {
        const out = await translator.translate(paragraphs[i], { signal });
        yield (i ? '\n\n' : '') + out;
      }
    },

    async scene(story, signal) {
      const session = await newSession(SCENE_SYSTEM, signal, onProgress);
      try {
        const raw = await session.prompt(buildScenePrompt(story), { signal, responseConstraint: SCENE_SCHEMA });
        return normalizeScene(raw, story);
      } finally {
        session.destroy();
      }
    },

    /** Trigger model downloads from a user gesture. */
    async prepare(targetLang) {
      const jobs = [];
      if (has('LanguageModel')) jobs.push(newSession(STORY_SYSTEM, undefined, onProgress).then((s) => s.destroy()));
      if (has('Summarizer')) jobs.push(g.Summarizer.create({ ...SUMMARIZER_OPTS, monitor: monitorFor('Summarizer', onProgress) }).then((s) => s.destroy()));
      if (targetLang && has('Translator')) jobs.push(getTranslator(targetLang));
      const results = await Promise.allSettled(jobs);
      const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message ?? String(r.reason));
      if (failed.length) throw new Error(failed.join('\n'));
    },
  };
}
