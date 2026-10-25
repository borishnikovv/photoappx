// Learns your taste from thumbs up/down, on this device. Layout votes tilt which layouts get
// chosen; photo votes learn which qualities you favor (color or muted, people or places, wide or
// close, bright or moody) and nudge future picks toward them.
import type { Photo } from '../types';

const KEY = 'seam.taste.v1';
const MAX_VOTES = 200;

interface Taste {
  templates: Record<string, number>;
  families: Record<string, number>;
  /** Feature vectors of photos you liked and didn't. */
  up: number[][];
  down: number[][];
}

const empty = (): Taste => ({ templates: {}, families: {}, up: [], down: [] });

function load(): Taste {
  try {
    return { ...empty(), ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return empty();
  }
}
let taste = load();
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(taste));
  } catch {
    /* storage unavailable: taste still applies for this session */
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Latest vote per layout or photo, so the UI can show it. */
const votes = new Map<string, 1 | -1>();
export const voteOf = (key: string) => votes.get(key) ?? 0;

export function voteLayout(sectionId: string, template: string, family: string, v: 1 | -1) {
  // Voting the same way twice takes the vote back.
  const prev = votes.get(sectionId) ?? 0;
  const delta = prev === v ? -v : v - prev;
  if (prev === v) votes.delete(sectionId);
  else votes.set(sectionId, v);
  taste.templates[template] = clamp((taste.templates[template] ?? 0) + delta, -4, 4);
  taste.families[family] = clamp((taste.families[family] ?? 0) + delta * 0.5, -4, 4);
  save();
}

/** Multiplier on a layout's base weight: liked layouts come up more, disliked ones rarely. */
export const layoutBias = (template: string, family: string) =>
  Math.exp(0.3 * (taste.templates[template] ?? 0) + 0.15 * (taste.families[family] ?? 0));

/** Qualities a photo vote teaches, each 0..1. */
function features(p: Photo) {
  const a = p.analysis;
  return [
    a?.colorfulness ?? 0.5,
    (a?.lab?.[0] ?? 50) / 100,
    a?.faces?.length ? Math.min(1, 0.4 + a.faces.reduce((s, f) => s + f.w * f.h, 0) * 6) : 0,
    p.width > p.height * 1.1 ? 1 : 0,
    a?.aesthetic ?? 0.5,
    a?.style ?? 0.5,
  ];
}

export function votePhoto(p: Photo, v: 1 | -1) {
  const prev = votes.get(p.id) ?? 0;
  const f = features(p);
  const drop = (list: number[][]) => {
    const i = list.findIndex((x) => x.every((y, k) => y === f[k]));
    if (i >= 0) list.splice(i, 1);
  };
  if (prev) drop(prev > 0 ? taste.up : taste.down);
  if (prev === v) votes.delete(p.id);
  else {
    votes.set(p.id, v);
    (v > 0 ? taste.up : taste.down).push(f);
    taste.up = taste.up.slice(-MAX_VOTES);
    taste.down = taste.down.slice(-MAX_VOTES);
  }
  weights = null;
  save();
}

let weights: number[] | null = null;
/** Direction from what you skip toward what you like (difference of the two averages). */
function learned() {
  if (weights) return weights;
  const n = taste.up.length + taste.down.length;
  if (n < 3) return (weights = []);
  const mean = (l: number[][]) => (l.length ? l[0].map((_, k) => l.reduce((s, x) => s + x[k], 0) / l.length) : null);
  const all = mean([...taste.up, ...taste.down])!;
  const up = mean(taste.up) ?? all, down = mean(taste.down) ?? all;
  // Confidence grows with the number of votes.
  const trust = Math.min(1, n / 20);
  return (weights = up.map((u, k) => (u - down[k]) * trust));
}

/** Score points (about ±8 at most) added to a photo's 0–100 score. */
export function photoBonus(p: Photo) {
  const w = learned();
  if (!w.length) return 0;
  const f = features(p);
  return clamp(w.reduce((s, x, k) => s + x * (f[k] - 0.5), 0) * 40, -8, 8);
}

export const tasteSummary = () => ({ layouts: Object.values(taste.templates).filter(Boolean).length, photos: taste.up.length + taste.down.length });

export function resetTaste() {
  taste = empty();
  weights = null;
  votes.clear();
  save();
}
