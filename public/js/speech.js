// Voice in (SpeechRecognition, on-device when Chrome supports it) and voice out
// (speechSynthesis, preferring voices that run locally).
import { recordEgress } from './privacy.js';

const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

/**
 * 'ondevice' | 'ondevice-downloadable' | 'cloud-only' | 'unsupported'
 * Chrome 139+ exposes SpeechRecognition.available({langs, processLocally}); an
 * older draft used availableOnDevice(lang). Without either, Chrome's recognizer
 * streams audio to a Google server.
 */
export async function recognitionMode(lang = 'en-US') {
  if (!Recognition) return 'unsupported';
  try {
    if (typeof Recognition.available === 'function') {
      const a = await Recognition.available({ langs: [lang], processLocally: true });
      if (a === 'available') return 'ondevice';
      if (a === 'downloadable' || a === 'downloading') return 'ondevice-downloadable';
      return 'cloud-only';
    }
    if (typeof Recognition.availableOnDevice === 'function') {
      const a = await Recognition.availableOnDevice(lang);
      if (a === 'available' || a === true) return 'ondevice';
      if (a === 'downloadable' || a === 'downloading') return 'ondevice-downloadable';
    }
  } catch { /* fall through */ }
  return 'cloud-only';
}

export async function installOnDeviceRecognition(lang = 'en-US') {
  if (typeof Recognition?.install === 'function') return Recognition.install({ langs: [lang], processLocally: true });
  if (typeof Recognition?.installOnDevice === 'function') return Recognition.installOnDevice(lang);
  return false;
}

/**
 * Listen once. `allowCloud` must be true to use the server-based recognizer;
 * when it is used, the ledger records it as egress.
 */
export function listen({ lang = 'en-US', mode, allowCloud = false, onInterim } = {}) {
  if (!Recognition) return { promise: Promise.reject(new Error('Speech recognition is not supported in this browser.')), stop() {} };
  const local = mode === 'ondevice';
  if (!local && !allowCloud) {
    return { promise: Promise.reject(new Error('On-device speech recognition is not available, so the mic is off to keep audio on this device. You can type instead, or allow cloud speech in Settings.')), stop() {} };
  }
  const rec = new Recognition();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  if (local) {
    if ('processLocally' in rec) rec.processLocally = true;
    else rec.mode = 'ondevice-only';
  } else {
    recordEgress('Microphone audio (browser cloud speech service)', 0);
  }
  const promise = new Promise((resolve, reject) => {
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      onInterim?.((finalText + ' ' + interim).trim());
    };
    rec.onerror = (e) => reject(new Error(e.error === 'not-allowed' ? 'Microphone permission was denied.' : `Speech recognition error: ${e.error}`));
    rec.onend = () => resolve(finalText.trim());
  });
  rec.start();
  return { promise, stop: () => rec.stop() };
}

// ---------------------------------------------------------------------------
// Read-aloud

let voicesReady = null;
function voices() {
  voicesReady ??= new Promise((resolve) => {
    const v = speechSynthesis.getVoices();
    if (v.length) return resolve(v);
    speechSynthesis.addEventListener('voiceschanged', () => resolve(speechSynthesis.getVoices()), { once: true });
    setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
  });
  return voicesReady;
}

export async function pickVoice(bcp47) {
  const all = await voices();
  const base = bcp47.split('-')[0].toLowerCase();
  const matches = all.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(base));
  // Local voices keep the story on the device; network voices send text to a server.
  return matches.find((v) => v.localService && v.lang.toLowerCase() === bcp47.toLowerCase())
    ?? matches.find((v) => v.localService)
    ?? null;
}

/**
 * Speak a list of {text, lang} segments in order. Returns a controller.
 * onSegment(index) fires as each segment starts so the UI can highlight it.
 */
export function speakSegments(segments, { rate = 0.9, onSegment, onEnd } = {}) {
  speechSynthesis.cancel();
  let cancelled = false;
  (async () => {
    for (let i = 0; i < segments.length && !cancelled; i++) {
      const { text, lang } = segments[i];
      const voice = await pickVoice(lang);
      if (!voice) continue; // no local voice for this language: skip rather than leak text
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        u.voice = voice;
        u.lang = voice.lang;
        u.rate = rate;
        u.pitch = 1.05;
        u.onstart = () => onSegment?.(i);
        u.onend = u.onerror = () => resolve();
        speechSynthesis.speak(u);
      });
    }
    onEnd?.(cancelled);
  })();
  return { stop() { cancelled = true; speechSynthesis.cancel(); } };
}
