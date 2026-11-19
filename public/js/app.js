import { LANGUAGES, countWords, heuristicScene } from './shared/prompts.js';
import { createOnDeviceEngine, onDeviceCapabilities } from './engines/ondevice.js';
import { cloudEngine, cloudStatus } from './engines/cloud.js';
import { onLedgerChange, ledger } from './privacy.js';
import { recognitionMode, installOnDeviceRecognition, listen, speakSegments, pickVoice } from './speech.js';
import { WonderWorld } from './world/renderer.js';

const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------------------
// Preferences (kept in this browser only)

const PREFS_KEY = 'storyforge.prefs.v1';
const SHELF_KEY = 'storyforge.shelf.v1';
const prefs = { engine: 'ondevice', lang: 'es', age: 5, length: 'short', rate: 0.9, allowCloudSpeech: false, ...load(PREFS_KEY, {}) };
function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } }
const savePrefs = () => save(PREFS_KEY, prefs);

const IDEAS = [
  'a sleepy little fox who finds a glowing star',
  'a robot who learns to whisper goodnight',
  'a bunny and a turtle having a picnic on the moon',
  'a shy dragon who is afraid of the dark',
  'a fish who wants to see the stars',
  'a kid who builds a blanket castle',
];

// ---------------------------------------------------------------------------
// Form wiring

const langSel = $('#lang');
for (const l of LANGUAGES) langSel.add(new Option(l.name, l.code));
langSel.value = prefs.lang;
$('#age').value = prefs.age; $('#age-out').value = prefs.age;
$('#length').value = prefs.length;
$(`input[name="engine"][value="${prefs.engine}"]`).checked = true;
$('#rate').value = prefs.rate; $('#rate-out').value = prefs.rate;
$('#allow-cloud-speech').checked = prefs.allowCloudSpeech;

$('#ideas').replaceChildren(...IDEAS.map((idea) => {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = idea;
  b.onclick = () => { $('#premise').value = idea; $('#premise').focus(); };
  return b;
}));

langSel.onchange = () => { prefs.lang = langSel.value; savePrefs(); refreshCaps(); };
$('#age').oninput = (e) => { prefs.age = +e.target.value; $('#age-out').value = prefs.age; savePrefs(); };
$('#length').onchange = (e) => { prefs.length = e.target.value; savePrefs(); };
document.querySelectorAll('input[name="engine"]').forEach((r) => (r.onchange = () => { prefs.engine = r.value; savePrefs(); }));
$('#rate').oninput = (e) => { prefs.rate = +e.target.value; $('#rate-out').value = prefs.rate; savePrefs(); };
$('#allow-cloud-speech').onchange = (e) => { prefs.allowCloudSpeech = e.target.checked; savePrefs(); refreshCaps(); };
$('#settings-btn').onclick = () => $('#settings').showModal();

// ---------------------------------------------------------------------------
// Privacy ledger badge

const fmtBytes = (b) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);
onLedgerChange((s) => {
  const leaked = s.requests > 0;
  $('#privacy-badge').classList.toggle('leaked', leaked);
  $('#privacy-text').textContent = leaked
    ? `${s.requests} cloud request${s.requests === 1 ? '' : 's'} · ${fmtBytes(s.bytesOut)} sent`
    : 'Nothing has left this device';
});
$('#privacy-badge').onclick = () => {
  const s = ledger();
  $('#ledger-summary').textContent = s.requests
    ? `${s.requests} request(s), ${fmtBytes(s.bytesOut)} of story data sent to the cloud engine this session.`
    : 'Nothing. Every story so far was written, translated, titled and drawn on this device.';
  $('#ledger-list').replaceChildren(...s.events.map((e) => {
    const li = document.createElement('li');
    li.textContent = `${e.at.toLocaleTimeString()} · ${e.what}${e.bytes ? ` · ${fmtBytes(e.bytes)}` : ''}`;
    return li;
  }));
  $('#ledger').showModal();
};

// ---------------------------------------------------------------------------
// Capabilities

const downloads = new Map();
const ondevice = createOnDeviceEngine({
  onProgress(label, loaded) {
    downloads.set(label, loaded);
    $('#prepare-status').textContent = [...downloads].map(([k, v]) => `${k}: ${Math.round(v * 100)}%`).join(' · ');
  },
});

const PILL = {
  available: ['good', 'Ready'], ondevice: ['good', 'On-device'], downloadable: ['warn', 'Needs download'],
  'ondevice-downloadable': ['warn', 'Needs download'], downloading: ['warn', 'Downloading'],
  unavailable: ['bad', 'Not on this device'], unsupported: ['bad', 'Not in this browser'],
  'cloud-only': ['cloud', 'Cloud only'], cloud: ['cloud', 'Configured'], missing: ['bad', 'No API key'],
};
let speechMode = 'unsupported';

async function refreshCaps() {
  const target = langSel.value;
  const [caps, sMode, cloud, voice, trVoice] = await Promise.all([
    onDeviceCapabilities(target), recognitionMode('en-US'), cloudStatus(),
    'speechSynthesis' in window ? pickVoice('en-US') : null,
    target && 'speechSynthesis' in window ? pickVoice(LANGUAGES.find((l) => l.code === target).bcp47) : null,
  ]);
  speechMode = sMode;
  const gpu = navigator.gpu ? !!(await navigator.gpu.requestAdapter().catch(() => null)) : false;
  const rows = [
    ['Story writer', 'Prompt API · Gemini Nano', caps.prompt],
    ['Titles', 'Summarizer API', caps.summarizer === 'unsupported' && caps.prompt !== 'unsupported' ? 'available' : caps.summarizer,
      caps.summarizer === 'unsupported' ? 'Falls back to the Prompt API' : ''],
    ['Translation', target ? `Translator API · en → ${target}` : 'Translator API (pick a language)', target ? caps.translator : 'unsupported'],
    ['Listening', 'Web Speech recognition', sMode, sMode === 'cloud-only' ? (prefs.allowCloudSpeech ? 'Allowed in Settings: audio goes to the browser vendor' : 'Mic disabled to keep audio local; typing works') : ''],
    ['Reading aloud', 'speechSynthesis, local voices', voice ? 'available' : 'unavailable',
      [voice?.name, target ? (trVoice ? trVoice.name : `no local ${target} voice`) : ''].filter(Boolean).join(' · ')],
    ['Wonder World', 'WebGPU', gpu ? 'available' : 'unavailable', gpu ? '' : 'Uses a simple 2D fallback'],
    ['Cloud engine', cloud.model ? `Claude (${cloud.model}) via local server` : 'Local server', cloud.configured ? 'cloud' : 'missing',
      cloud.unreachable ? 'Server not reachable' : ''],
  ];
  $('#caps-body').replaceChildren(...rows.map(([name, api, status, note]) => {
    const tr = document.createElement('tr');
    const [cls, label] = PILL[status] ?? ['bad', status];
    tr.innerHTML = `<td><strong></strong><br><span class="hint"></span></td><td><span class="pill ${cls}"></span> <span class="hint"></span></td>`;
    tr.querySelector('strong').textContent = name;
    tr.querySelectorAll('.hint')[0].textContent = api;
    tr.querySelector('.pill').textContent = label;
    tr.querySelectorAll('.hint')[1].textContent = note ?? '';
    return tr;
  }));
  const ready = caps.prompt === 'available';
  $('#caps-summary').textContent = ready ? '· on-device storyteller ready' : `· on-device storyteller: ${PILL[caps.prompt]?.[1] ?? caps.prompt}`;
  if (!ready && caps.prompt !== 'unsupported') $('#caps').open = true;
  if (caps.prompt === 'unsupported' && prefs.engine === 'ondevice') $('#caps').open = true;
}

$('#prepare-btn').onclick = async () => {
  $('#prepare-status').textContent = 'Starting downloads…';
  try {
    const jobs = [ondevice.prepare(langSel.value)];
    if (speechMode === 'ondevice-downloadable') jobs.push(installOnDeviceRecognition('en-US'));
    await Promise.all(jobs);
    $('#prepare-status').textContent = 'All set.';
  } catch (err) {
    $('#prepare-status').textContent = err.message;
  }
  refreshCaps();
};

// ---------------------------------------------------------------------------
// Microphone

let listening = null;
$('#mic-btn').onclick = async () => {
  const status = $('#mic-status');
  if (listening) { listening.stop(); return; }
  if (speechMode === 'ondevice-downloadable') {
    status.textContent = 'Downloading the on-device speech model…';
    try { await installOnDeviceRecognition('en-US'); } catch { /* reported below */ }
    speechMode = await recognitionMode('en-US');
  }
  status.textContent = speechMode === 'ondevice' ? 'Listening on this device… tell me your idea!' : 'Listening…';
  $('#mic-btn').classList.add('listening');
  listening = listen({
    lang: 'en-US', mode: speechMode, allowCloud: prefs.allowCloudSpeech,
    onInterim: (t) => { $('#premise').value = t; },
  });
  try {
    const text = await listening.promise;
    if (text) { $('#premise').value = text; status.textContent = 'Got it! Press “Forge a story” when ready.'; }
    else status.textContent = "I didn't catch that. Try again?";
  } catch (err) {
    status.textContent = err.message;
  } finally {
    listening = null;
    $('#mic-btn').classList.remove('listening');
  }
};

// ---------------------------------------------------------------------------
// Story panels

const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

class Panel {
  constructor(engine, cloudModel) {
    this.engine = engine;
    this.el = $('#panel-tpl').content.firstElementChild.cloneNode(true);
    const tag = $('.engine-tag', this.el);
    tag.classList.add(engine.id);
    tag.textContent = engine.id === 'cloud' ? `☁️ Cloud · ${cloudModel ?? 'Claude'}` : '📱 On-device · Gemini Nano';
    this.storyEl = $('.story', this.el);
    this.metrics = {};
    this.story = '';
    this.translation = '';
    this.title = '';
    $('.read-btn', this.el).onclick = () => this.toggleRead();
  }

  async mountWorld() {
    this.world = new WonderWorld($('.world-canvas', this.el), $('.world-labels', this.el));
    const label = (mode) => { $('.world-mode', this.el).textContent = mode === 'webgpu' ? 'WebGPU' : '2D fallback'; };
    this.world.onModeChange = label;
    label(await this.world.init());
  }

  dispose() {
    this.reading?.stop();
    this.world?.destroy();
  }

  setMetric(key, label, value) {
    this.metrics[key] = { label, value };
    $('.metrics', this.el).replaceChildren(...Object.values(this.metrics).map(({ label, value }) => {
      const d = document.createElement('div');
      d.innerHTML = '<dt></dt><dd></dd>';
      d.firstChild.textContent = label; d.lastChild.textContent = value;
      return d;
    }));
  }

  showError(msg) {
    const e = $('.error', this.el);
    e.hidden = false;
    e.textContent = (e.textContent ? e.textContent + '\n' : '') + msg;
  }

  render({ streaming = false } = {}) {
    const en = this.story.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    const tr = this.translation.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    this.paragraphs = en;
    this.trParagraphs = tr;
    this.storyEl.classList.toggle('bilingual', tr.length > 0);
    this.storyEl.replaceChildren(...en.map((p, i) => {
      const div = document.createElement('div');
      div.className = 'para';
      div.dataset.i = i;
      const a = document.createElement('p');
      a.textContent = p;
      a.lang = 'en';
      if (streaming && i === en.length - 1) a.classList.add('cursor');
      div.append(a);
      if (tr[i]) {
        const b = document.createElement('p');
        b.className = 'tr';
        b.lang = this.lang;
        b.textContent = tr[i];
        div.append(b);
      }
      return div;
    }));
  }

  toggleRead() {
    const btn = $('.read-btn', this.el);
    if (this.reading) { this.reading.stop(); return; }
    const mode = $('.read-mode', this.el).value;
    const bcp = LANGUAGES.find((l) => l.code === this.lang)?.bcp47;
    const segs = [];
    if (this.title) segs.push({ text: this.title, lang: 'en-US', i: -1 });
    this.paragraphs.forEach((p, i) => {
      if (mode !== 'tr') segs.push({ text: p, lang: 'en-US', i });
      if (mode !== 'en' && bcp && this.trParagraphs[i]) segs.push({ text: this.trParagraphs[i], lang: bcp, i });
    });
    btn.textContent = '⏹ Stop reading';
    this.reading = speakSegments(segs, {
      rate: prefs.rate,
      onSegment: (k) => {
        this.storyEl.querySelectorAll('.speaking').forEach((n) => n.classList.remove('speaking'));
        const target = this.storyEl.querySelector(`.para[data-i="${segs[k].i}"]`);
        target?.classList.add('speaking');
        target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
      onEnd: () => {
        this.reading = null;
        btn.textContent = '🔊 Read aloud';
        this.storyEl.querySelectorAll('.speaking').forEach((n) => n.classList.remove('speaking'));
      },
    });
  }

  /** Run the whole pipeline for one engine. */
  async run({ premise, age, length, lang }, signal) {
    this.lang = lang;
    const t0 = performance.now();
    let first = null;
    this.setMetric('ttft', 'First words', '…');
    try {
      for await (const delta of this.engine.storyStream({ premise, age, length }, signal)) {
        if (first == null) { first = performance.now() - t0; this.setMetric('ttft', 'First words', fmtMs(first)); }
        this.story += delta;
        this.render({ streaming: true });
      }
    } catch (err) {
      if (signal.aborted) return;
      this.showError(err.message);
      if (first == null) this.setMetric('ttft', 'First words', '—');
      $('.story-title', this.el).textContent = this.story ? 'An unfinished story' : 'No story this time';
      this.render();
      return;
    }
    const total = performance.now() - t0;
    const words = countWords(this.story);
    this.render();
    this.setMetric('total', 'Whole story', fmtMs(total));
    this.setMetric('words', 'Words', String(words));
    this.setMetric('wps', 'Words / sec', (words / Math.max(0.001, (total - (first ?? 0)) / 1000)).toFixed(1));

    const timed = async (key, label, fn) => {
      const s = performance.now();
      this.setMetric(key, label, '…');
      try {
        const out = await fn();
        this.setMetric(key, label, fmtMs(performance.now() - s));
        return out;
      } catch (err) {
        if (!signal.aborted) { this.setMetric(key, label, 'failed'); this.showError(`${label}: ${err.message}`); }
        return null;
      }
    };

    await Promise.all([
      timed('title', 'Title', async () => {
        this.title = (await this.engine.title(this.story, signal)) || 'A Bedtime Story';
        $('.story-title', this.el).textContent = this.title;
      }),
      timed('scene', 'Scene', async () => {
        this.scene = await this.engine.scene(this.story, signal);
        this.world.setScene(this.scene);
      }).then(() => { if (!this.scene) { this.scene = heuristicScene(this.story); this.world.setScene(this.scene); } }),
      lang && timed('translate', 'Translation', async () => {
        for await (const delta of this.engine.translateStream(this.story, lang, signal)) {
          this.translation += delta;
          this.render();
        }
      }),
    ]);
    if ($('.story-title', this.el).textContent === '…') $('.story-title', this.el).textContent = 'A Bedtime Story';
    const sent = this.engine.id === 'cloud'
      ? ledger().events.filter((e) => e.at >= this.startedAt && e.what.includes('(cloud)')).reduce((a, e) => a + e.bytes, 0)
      : 0;
    this.setMetric('egress', 'Sent off device', fmtBytes(sent));
    addToShelf({ title: this.title, premise, story: this.story, translation: this.translation, lang, scene: this.scene, engine: this.engine.id, at: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// Forge

let controller = null;
let activePanels = [];
function clearPanels() {
  activePanels.forEach((p) => p.dispose());
  activePanels = [];
  $('#results').replaceChildren();
}
$('#forge-btn').onclick = async () => {
  controller?.abort();
  controller = new AbortController();
  const premise = $('#premise').value.trim() || IDEAS[Math.floor(Math.random() * IDEAS.length)];
  $('#premise').value = premise;
  const opts = { premise, age: prefs.age, length: prefs.length, lang: langSel.value };
  const cloud = prefs.engine === 'ondevice' ? null : await cloudStatus();
  const engines = prefs.engine === 'compare' ? [ondevice, cloudEngine] : prefs.engine === 'cloud' ? [cloudEngine] : [ondevice];

  const results = $('#results');
  clearPanels();
  const panels = engines.map((e) => new Panel(e, cloud?.model));
  panels.forEach((p) => results.append(p.el));
  activePanels = panels;
  await Promise.all(panels.map((p) => p.mountWorld()));
  panels.forEach((p) => p.world.setScene({ setting: 'forest', time: 'night', characters: [] }));
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });

  $('#forge-btn').disabled = true;
  $('#stop-btn').hidden = false;
  const signal = controller.signal;
  await Promise.all(panels.map((p) => { p.startedAt = new Date(); return p.run(opts, signal); }));
  $('#forge-btn').disabled = false;
  $('#stop-btn').hidden = true;
};
$('#stop-btn').onclick = () => {
  controller?.abort();
  speechSynthesis.cancel();
  $('#forge-btn').disabled = false;
  $('#stop-btn').hidden = true;
};

// ---------------------------------------------------------------------------
// Story shelf (this browser only)

function addToShelf(entry) {
  const shelf = load(SHELF_KEY, []);
  shelf.unshift(entry);
  save(SHELF_KEY, shelf.slice(0, 12));
  renderShelf();
}

function renderShelf() {
  const shelf = load(SHELF_KEY, []);
  $('#shelf-section').hidden = shelf.length === 0;
  $('#shelf').replaceChildren(...shelf.map((s) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<strong></strong><small></small>';
    b.firstChild.textContent = s.title || 'A Bedtime Story';
    b.lastChild.textContent = `${s.engine === 'cloud' ? '☁️' : '📱'} ${new Date(s.at).toLocaleString()} · ${s.premise}`;
    b.onclick = () => reopen(s);
    li.append(b);
    return li;
  }));
}

async function reopen(s) {
  const engine = s.engine === 'cloud' ? cloudEngine : ondevice;
  const p = new Panel(engine);
  Object.assign(p, { story: s.story, translation: s.translation, title: s.title, lang: s.lang, scene: s.scene });
  $('.story-title', p.el).textContent = s.title;
  controller?.abort();
  clearPanels();
  $('#results').append(p.el);
  activePanels = [p];
  await p.mountWorld();
  p.world.setScene(s.scene ?? heuristicScene(s.story));
  p.render();
  p.el.scrollIntoView({ behavior: 'smooth' });
}

renderShelf();
refreshCaps();
