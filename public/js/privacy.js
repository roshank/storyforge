// The privacy ledger: every byte that leaves the device goes through here, so the
// badge in the header is a true accounting, not a promise.

const listeners = new Set();
const state = { bytesOut: 0, requests: 0, events: [] };

export function recordEgress(what, bytes) {
  state.bytesOut += bytes;
  state.requests += 1;
  state.events.push({ what, bytes, at: new Date() });
  listeners.forEach((fn) => fn(state));
}

export function onLedgerChange(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export function ledger() { return state; }

/** fetch() wrapper used for every off-device call. */
export async function egressFetch(what, url, init = {}) {
  const bytes = new TextEncoder().encode(String(init.body ?? '')).length + url.length;
  recordEgress(what, bytes);
  return fetch(url, init);
}
