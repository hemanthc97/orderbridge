// Shared primitives: a seeded random source, a virtual-time scheduler and small helpers.
// Everything in the engine runs on virtual time so a scenario replays identically for a given seed.

export const BASE_EPOCH = Date.UTC(2026, 10, 16, 8, 0, 0);

export class ParseError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
    this.detail = detail;
  }
}

// mulberry32: small, fast, good enough for simulation and fully reproducible.
export function createRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.chance = (p) => next() < p;
  next.sample = (arr, n) => {
    const pool = arr.slice();
    const out = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
    return out;
  };
  return next;
}

// Discrete-event scheduler. Events at the same instant run in the order they were scheduled.
export class Scheduler {
  constructor() {
    this.now = 0;
    this.queue = [];
    this.seq = 0;
  }

  at(delayMs, fn) {
    const event = { t: this.now + Math.max(0, delayMs), s: this.seq++, fn };
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const q = this.queue[mid];
      if (q.t < event.t || (q.t === event.t && q.s < event.s)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, event);
    return event;
  }

  get pending() {
    return this.queue.length;
  }

  // Run every event due up to and including `to`, then move the clock there.
  advanceTo(to) {
    while (this.queue.length && this.queue[0].t <= to) {
      const event = this.queue.shift();
      this.now = event.t;
      event.fn();
    }
    if (to > this.now) this.now = to;
  }

  // Run until no events remain. `limit` guards against a runaway loop.
  drain(limit = 2_000_000) {
    let n = 0;
    while (this.queue.length) {
      if (++n > limit) throw new Error('Scheduler did not settle');
      const event = this.queue.shift();
      this.now = event.t;
      event.fn();
    }
  }
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const pad = (v, n, c = '0') => String(v).padStart(n, c);
export const isoDate = (epochMs) => new Date(epochMs).toISOString().slice(0, 10);
const dayMs = 86_400_000;
const toEpoch = (iso) => Date.parse(`${iso}T00:00:00Z`);
export const addDays = (iso, n) => isoDate(toEpoch(iso) + n * dayMs);
export const daysBetween = (fromIso, toIso) => Math.round((toEpoch(toIso) - toEpoch(fromIso)) / dayMs);
export const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toEpoch(s));
export const compactDate = (iso) => iso.replaceAll('-', '');
export const usDate = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

// Virtual milliseconds since scenario start, shown as a wall-clock time of day.
export function clockLabel(virtualMs, withMs = false) {
  const d = new Date(BASE_EPOCH + virtualMs);
  const base = d.toISOString().slice(11, 19);
  return withMs ? `${base}.${pad(d.getUTCMilliseconds(), 3)}` : base;
}

export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
