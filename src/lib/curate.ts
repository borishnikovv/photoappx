import type { Analysis, Decision, FaceBox, Photo } from '../types';
import type { TechResult } from '../workers/technical.worker';
import { detectFaces } from './faces';
import { photoOrientation } from './geometry';

interface ClipResult {
  embedding: Float32Array;
  aesthetic: number;
  style: number;
  flag?: string;
  hardReject: boolean;
}

export interface Progress {
  stage: string;
  done: number;
  total: number;
  modelProgress?: number;
}

/** Runs one job per photo through a worker, `size` workers at a time. */
function pool<T>(make: () => Worker, size: number) {
  const workers = Array.from({ length: size }, make);
  const waiting = new Map<string, (v: T | null) => void>();
  for (const w of workers)
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress' || d.type === 'ready') return;
      waiting.get(d.id)?.(d.error ? null : d);
      waiting.delete(d.id);
    };
  let next = 0;
  return {
    run: (id: string, blob: Blob) =>
      new Promise<T | null>((res) => {
        waiting.set(id, res);
        workers[next++ % size].postMessage({ type: 'image', id, blob });
      }),
    workers,
    stop: () => workers.forEach((w) => w.terminate()),
  };
}

let clipWorker: Worker | null = null;
let clipState: Promise<boolean> | null = null;

function clip(onModel: (p: number) => void) {
  clipWorker ??= new Worker(new URL('../workers/clip.worker.ts', import.meta.url), { type: 'module' });
  clipState ??= new Promise<boolean>((res) => {
    const w = clipWorker!;
    const t = setTimeout(() => res(false), 180_000);
    w.onmessage = (e) => {
      if (e.data.type === 'progress') onModel(e.data.progress);
      if (e.data.type === 'ready') { clearTimeout(t); res(true); }
      if (e.data.type === 'error' && !e.data.id) { clearTimeout(t); console.warn('CLIP unavailable', e.data.error); res(false); }
    };
    w.onerror = () => { clearTimeout(t); res(false); };
    w.postMessage({ type: 'init' });
  });
  return clipState;
}

const thumbBlob = (p: Photo) => fetch(p.thumb).then((r) => r.blob());

/** One-off technical measurement, e.g. to check a straightened photo is now level. */
export async function measure(blob: Blob): Promise<TechResult | null> {
  const one = pool<TechResult>(() => new Worker(new URL('../workers/technical.worker.ts', import.meta.url), { type: 'module' }), 1);
  try {
    return await one.run('m', blob);
  } finally {
    one.stop();
  }
}

export async function analyzeAll(photos: Photo[], onProgress: (p: Progress) => void, onPhoto: (id: string, a: Analysis) => void) {
  const todo = photos.filter((p) => !p.analysis);
  const total = todo.length;
  const tech = pool<TechResult>(
    () => new Worker(new URL('../workers/technical.worker.ts', import.meta.url), { type: 'module' }),
    Math.min(4, navigator.hardwareConcurrency || 2),
  );

  onProgress({ stage: 'Loading art-director model', done: 0, total, modelProgress: 0 });
  const hasClip = await clip((m) => onProgress({ stage: 'Loading art-director model', done: 0, total, modelProgress: m }));
  const clipPool = hasClip && clipWorker ? wrapClip(clipWorker) : null;

  let done = 0;
  const results = new Map<string, Analysis>();
  const queue = [...todo];
  const work = async () => {
    while (queue.length) {
      const p = queue.shift()!;
      const blob = await thumbBlob(p);
      const [t, c, faces] = await Promise.all([
        tech.run(p.id, blob),
        clipPool ? clipPool(p.id, blob) : Promise.resolve(null),
        detectFaces(p.file).catch(() => undefined),
      ]);
      if (t) {
        const a = score(p, t, c, faces);
        results.set(p.id, a);
        onPhoto(p.id, a);
      }
      onProgress({ stage: hasClip ? 'Reviewing photos' : 'Reviewing photos (basic mode)', done: ++done, total });
    }
  };
  await Promise.all([work(), work()]);
  tech.stop();
  return { results, hasClip };
}

function wrapClip(w: Worker) {
  const waiting = new Map<string, (v: ClipResult | null) => void>();
  w.onmessage = (e) => {
    const d = e.data;
    if (d.type !== 'result' && d.type !== 'error') return;
    waiting.get(d.id)?.(d.type === 'result' ? d : null);
    waiting.delete(d.id);
  };
  return (id: string, blob: Blob) =>
    new Promise<ClipResult | null>((res) => {
      waiting.set(id, res);
      w.postMessage({ type: 'image', id, blob });
    });
}

/** Blends every signal into one 0..100 score plus plain-language reasons. */
function score(p: Photo, t: TechResult, c: ClipResult | null, faces?: FaceBox[]): Analysis {
  const reasons: string[] = [];
  let reject = false;

  const tech = 0.6 * t.sharpness + 0.4 * t.exposure;
  if (t.sharpness < 0.22) { reasons.push('Out of focus'); reject = true; }
  else if (t.sharpness > 0.75) reasons.push('Crisp detail');
  reasons.push(...t.notes);
  if (t.exposure < 0.45) reject = true;

  // Screens and graphics have long runs of identical pixels in very few colors; photos (even skies) don't.
  // Strict on purpose: minimal photos (open sky, a plain wall) can be quite flat too.
  const graphic = (t.flatness > 0.6 && t.coverage > 0.88 && t.colorfulness < 0.35) || /screen ?shot|screen_?record/i.test(p.name);
  if (graphic) { reasons.push('Looks like a screenshot or graphic'); reject = true; }

  let faceScore = 0.7;
  const main = faces?.filter((f) => f.w * f.h > 0.004) ?? [];
  if (main.length) {
    const worstEyes = Math.max(...main.map((f) => f.eyesClosed));
    const cutOff = main.some((f) => f.w * f.h > 0.02 && (f.x < 0.005 || f.x + f.w > 0.995 || f.y < 0.005));
    const smile = Math.max(...main.map((f) => f.smile));
    faceScore = 0.85 + 0.15 * smile;
    if (worstEyes > 0.55) {
      faceScore -= 0.5;
      reasons.push(main.length > 1 ? 'Someone is blinking' : 'Eyes closed');
      if (worstEyes > 0.7 && main.some((f) => f.w * f.h > 0.03)) reject = true;
    }
    if (cutOff) { faceScore -= 0.2; reasons.push('Face cut off at edge'); }
    if (smile > 0.5 && worstEyes < 0.4) reasons.push('Natural expression');
  }

  let s: number;
  if (c) {
    s = 0.45 * c.aesthetic + 0.15 * c.style + 0.22 * tech + 0.06 * t.colorfulness + 0.04 * t.contrast + 0.08 * faceScore;
    if (c.aesthetic > 0.6) reasons.unshift('Strong, artful frame');
    if (c.style > 0.6) reasons.push('Candid / documentary feel');
    if (c.flag) reasons.push(c.flag);
    if (c.hardReject) reject = true;
  } else {
    s = 0.55 * tech + 0.15 * t.colorfulness + 0.15 * t.contrast + 0.15 * faceScore;
  }
  if (photoOrientation(p) === 'pano' && !reject) reasons.push('Panorama: can span slides');

  return {
    sharpness: t.sharpness,
    exposure: t.exposure,
    colorfulness: t.colorfulness,
    lab: t.lab,
    palette: t.palette,
    hash: t.hash,
    grid: t.grid,
    hist: t.hist,
    detail: t.detail,
    embedding: c?.embedding,
    aesthetic: c?.aesthetic,
    style: c?.style,
    faces,
    score: Math.round(Math.min(1, Math.max(0, s)) * 100 * (reject ? 0.5 : 1)),
    tilt: t.tilt,
    tiltConfidence: t.tiltConfidence,
    tiltSource: t.tiltSource,
    reject,
    reasons: [...new Set(reasons)],
  };
}

const hamming = (a: string, b: string) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
};

const cosine = (a?: Float32Array, b?: Float32Array) => {
  if (!a || !b) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Groups bursts and near-duplicates; marks the best frame of each group. Mutates analyses. */
export function groupDuplicates(photos: Photo[]) {
  const ps = photos.filter((p) => p.analysis).sort((a, b) => a.date - b.date);
  const parent = new Map(ps.map((p) => [p.id, p.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < Math.min(ps.length, i + 25); j++) {
      const a = ps[i].analysis!, b = ps[j].analysis!;
      const close = Math.abs(ps[i].date - ps[j].date) < 10 * 60_000;
      const same = hamming(a.hash, b.hash) <= 10 || cosine(a.embedding, b.embedding) > 0.94;
      if (close && same) parent.set(find(ps[j].id), find(ps[i].id));
    }
  const best = new Map<string, Photo>();
  for (const p of ps) {
    const g = find(p.id);
    p.analysis!.groupId = g;
    const cur = best.get(g);
    if (!cur || p.analysis!.score > cur.analysis!.score) best.set(g, p);
  }
  const sizes = new Map<string, number>();
  for (const p of ps) sizes.set(p.analysis!.groupId!, (sizes.get(p.analysis!.groupId!) ?? 0) + 1);
  for (const p of ps) {
    const a = p.analysis!;
    a.groupBest = best.get(a.groupId!) === p;
    a.reasons = a.reasons.filter((r) => !r.startsWith('Best of') && !r.startsWith('Similar to'));
    const n = sizes.get(a.groupId!)!;
    if (n > 1) a.reasons.unshift(a.groupBest ? `Best of ${n} similar shots` : 'Similar to a stronger frame');
  }
}

export type Sequence = 'story' | 'color';

/**
 * How different two photos look, roughly 0 (same shot) to 1+ (unrelated): composition and color
 * from the fingerprint, plus what's in the picture when the art-director model is available.
 */
export function distance(a: Analysis, b: Analysis) {
  let g = 0;
  for (let i = 0; i < a.grid.length; i += 3)
    g += Math.abs(a.grid[i] - b.grid[i]) + 0.6 * (Math.abs(a.grid[i + 1] - b.grid[i + 1]) + Math.abs(a.grid[i + 2] - b.grid[i + 2]));
  g /= (a.grid.length / 3) * 30;
  let bc = 0;
  for (let i = 0; i < a.hist.length; i++) bc += a.hist[i] * b.hist[i];
  const look = 0.65 * g + 0.35 * (1 - Math.min(1, bc));
  if (!a.embedding || !b.embedding) return look;
  return 0.45 * look + 0.55 * (1 - cosine(a.embedding, b.embedding)) * 3;
}

/** Most photos of one scene a carousel may hold; beyond that it reads as repetition. */
const MAX_PER_SCENE = 3;

/** Photos closer than this are the same scene seen almost the same way: never picked together. */
const SAME_SCENE = 0.36;

/**
 * The "same scene" distance for this album. In a varied album unrelated photos sit far apart, so
 * the full limit applies; in a very uniform one (one beach, one light all day) everything is
 * closer, so the limit shrinks with it instead of rejecting most of the album.
 */
export function sameSceneFor(analyses: Analysis[]) {
  const all: number[] = [];
  const step = Math.max(1, Math.floor(analyses.length / 120));
  for (let i = 0; i < analyses.length; i += step) for (let j = i + step; j < analyses.length; j += step) all.push(distance(analyses[i], analyses[j]));
  return all.length ? Math.min(SAME_SCENE, 0.6 * quantile(all, 0.1)) : SAME_SCENE;
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

/**
 * Splits the album (in time order) into moments: a new moment starts where the look changes
 * sharply from one photo to the next, or after a long time gap.
 */
function moments(cands: Photo[], D: number[][]) {
  const steps = cands.slice(1).map((_, i) => D[i][i + 1]);
  // Most consecutive photos belong to the same moment, so the median step is "same moment";
  // a jump well beyond it is a change of scene.
  const cut = 2 * quantile(steps, 0.5);
  // Same idea for time, when the dates are real (shared-album links don't carry any).
  const gaps = cands.slice(1).map((p, i) => p.date - cands[i].date);
  const longPause = Math.max(10 * 60_000, 6 * quantile(gaps, 0.5));
  const out: number[][] = [[0]];
  for (let i = 1; i < cands.length; i++) {
    if (gaps[i - 1] > longPause || steps[i - 1] > cut) out.push([]);
    out[out.length - 1].push(i);
  }
  return out;
}

/**
 * Chooses strong photos that are all different from each other and represent the whole folder:
 * every moment of the album contributes its best frame first (spread evenly across the album when
 * there are more moments than slots); extra slots then go round-robin, one per moment per round,
 * to frames that still look different from everything chosen. Then orders them, hero first.
 */
export function curate(photos: Photo[], count: number, seq: Sequence): string[] {
  const cands = photos
    .filter((p) => p.analysis && !p.analysis.reject && p.analysis.groupBest !== false && p.analysis.grid)
    .sort((a, b) => a.date - b.date);
  const k = Math.min(count, cands.length);
  const n = cands.length;
  if (!n) return [];
  const D = cands.map((a, i) => cands.map((b, j) => (i === j ? Infinity : j < i ? 0 : distance(a.analysis!, b.analysis!))));
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) D[i][j] = D[j][i];
  const score = (i: number) => cands[i].analysis!.score;
  // "Same shot" radius, learned from this album (half the photos have a twin closer than this), but
  // never so small that near-repeats (a burst, a stereo pair, a slight reframe) count as variety.
  const sameScene = sameSceneFor(cands.map((p) => p.analysis!));
  const radius = Math.max(sameScene, quantile(D.map((row) => Math.min(...row)), 0.5));
  const floor = quantile(cands.map((_, i) => score(i)), 0.25);
  const chosen: number[] = [];
  // At most 3 photos of any one scene in the whole carousel: count look-alikes wherever they are.
  // "Look-alike" is relative to the album: only its very closest pairs count, so a uniform album
  // (one place, one light) isn't mistaken for one big scene.
  const pairs: number[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push(D[i][j]);
  const alikeAt = Math.min(sameScene * 1.6, quantile(pairs, 0.04));
  const alike = (i: number) => chosen.filter((c) => D[i][c] < alikeAt).length;
  const distinct = (i: number, r = radius) => alike(i) < MAX_PER_SCENE && chosen.every((c) => D[i][c] > r);
  const byScore = (xs: number[]) => [...xs].sort((a, b) => score(b) - score(a));
  // Keep horizontals and verticals in healthy balance (spreads need both: wide backdrops, tall
  // frames on top) by nudging toward whichever is under-represented so far.
  const wide = (i: number) => ['landscape', 'pano'].includes(photoOrientation(cands[i]));
  const balance = (i: number) => {
    const nw = chosen.filter(wide).length, nt = chosen.length - nw;
    return Math.max(-8, Math.min(8, 3 * (wide(i) ? nt - nw : nw - nt)));
  };
  const best = (xs: number[]) => xs.reduce<number | undefined>((b, i) => (b == null || score(i) + balance(i) > score(b) + balance(b) ? i : b), undefined);

  const ms = moments(cands, D).map(byScore);
  const reps = ms.map((m) => m[0]);
  const momentOf = new Map(ms.flatMap((m, mi) => m.map((i) => [i, mi] as const)));
  const taken = (i: number) => chosen.filter((c) => momentOf.get(c) === momentOf.get(i)).length;
  // A moment is one scene only if its photos are close to each other compared with the album;
  // those get the 3-photo cap. A "moment" that's really a run of different scenes doesn't.
  const sceneLike = quantile(pairs, 0.3);
  const capOf = ms.map((m) => {
    const inner: number[] = [];
    for (let a = 0; a < m.length; a++) for (let b = a + 1; b < m.length; b++) inner.push(D[m[a]][m[b]]);
    return inner.length && quantile(inner, 0.5) < sceneLike ? MAX_PER_SCENE : Infinity;
  });
  const room = (i: number) => taken(i) < capOf[momentOf.get(i)!];
  if (reps.length >= k) {
    // More moments than slots: the best moment from each even stretch of the album.
    for (let s = 0; s < k; s++) {
      const stretch = byScore(reps.slice(Math.floor((s * reps.length) / k), Math.floor(((s + 1) * reps.length) / k)));
      const pick = best(stretch.filter((i) => distinct(i))) ?? stretch[0];
      if (pick != null && !chosen.includes(pick)) chosen.push(pick);
    }
  } else {
    for (const i of byScore(reps)) if (distinct(i)) chosen.push(i);
    // (Every moment's best goes in regardless of orientation; balance steers the seconds.)
    // Seconds, thirds…: bigger moments first within each round, only frames that add something new.
    const order = ms.map((_, i) => i).sort((a, b) => ms[b].length - ms[a].length);
    // No moment gets far more than its fair share while others still have something to give.
    const share = Math.ceil(k / ms.length) + 1;
    for (let round = 1; chosen.length < k && round < share; round++) {
      let added = 0;
      for (const mi of order) {
        if (chosen.length >= k) break;
        const next = best(ms[mi].filter((i) => !chosen.includes(i) && score(i) >= floor && room(i) && distinct(i)));
        if (next != null) {
          chosen.push(next);
          added++;
        }
      }
      if (!added || round > 50) break;
    }
  }
  // Still short (a small or very repetitive album): relax "different enough" step by step, but never
  // into near-repeats — fewer photos beats the same scene twice. Least-represented moments first.
  const radii: number[] = [];
  for (let r = radius * 0.8; r > sameScene; r *= 0.8) radii.push(r);
  radii.push(sameScene);
  for (const r of radii) {
    if (chosen.length >= k) break;
    const order = cands.map((_, i) => i).sort((a, b) => taken(a) - taken(b) || score(b) + balance(b) - score(a) - balance(a));
    for (const i of order) {
      if (chosen.length >= k) break;
      if (!chosen.includes(i) && room(i) && distinct(i, r)) chosen.push(i);
    }
  }
  const sceneOf = new Map(chosen.filter((i) => capOf[momentOf.get(i)!] !== Infinity).map((i) => [cands[i], momentOf.get(i)!] as const));
  return sequence(chosen.map((i) => cands[i]), seq, sceneOf).map((p) => p.id);
}

/** How close the camera is: 0 = wide, scene-setting view … 1 = close-up of a face or detail. */
function closeness(p: Photo) {
  const a = p.analysis;
  const faceArea = (a?.faces ?? []).reduce((s2, f) => s2 + f.w * f.h, 0);
  const d = a?.detail ?? [];
  // Wide views spread detail across the frame; close-ups concentrate it (and fill it with faces).
  const mean = d.length ? d.reduce((x, y) => x + y, 0) / d.length : 0.3;
  const peak = d.length ? Math.max(...d) : 0.3;
  const concentration = peak > 0 ? 1 - mean / peak : 0.5;
  const wide = ['landscape', 'pano'].includes(photoOrientation(p)) ? -0.15 : 0.1;
  return Math.max(0, Math.min(1, 0.45 * concentration + Math.min(1, faceArea * 6) * 0.5 + wide + 0.1));
}

/** Calm, quiet frames (little detail, soft light) make good endings. */
const calmness = (p: Photo) => 1 - (p.analysis?.detail?.reduce((x, y) => x + y, 0) ?? 32) / 64;

/**
 * Orders the picks as a story rather than a ranking: open on an establishing wide shot, move
 * through the day in time order, alternate wide views with close moments and details so it
 * breathes, never put two photos of the same scene side by side, and close on a calm frame.
 */
export function sequence(chosen: Photo[], seq: Sequence, sceneOf?: Map<Photo, number>): Photo[] {
  if (chosen.length < 3) return chosen;
  const score = (p: Photo) => p.analysis?.score ?? 0;
  const top = Math.max(...chosen.map(score));
  // Opener: strong and scene-setting (wide, not a close-up).
  const openerV = (p: Photo) => score(p) - top * 0.25 * closeness(p) + (['landscape', 'pano'].includes(photoOrientation(p)) ? 6 : 0);
  const opener = chosen.reduce((a, b) => (openerV(b) > openerV(a) ? b : a));
  let rest = chosen.filter((p) => p !== opener);
  // Closer: calm and good, late in the day.
  const t0 = Math.min(...rest.map((p) => p.date)), t1 = Math.max(...rest.map((p) => p.date));
  const closerV = (p: Photo) => score(p) * 0.5 + calmness(p) * 30 + ((p.date - t0) / Math.max(1, t1 - t0)) * 15;
  const closer = rest.length > 3 ? rest.reduce((a, b) => (closerV(b) > closerV(a) ? b : a)) : null;
  if (closer) rest = rest.filter((p) => p !== closer);

  let middle: Photo[];
  if (seq === 'story') middle = [...rest].sort((a, b) => a.date - b.date);
  else {
    // Color flow: walk to the nearest mean color each step, so tones blend slide to slide.
    middle = [];
    const pool = [...rest];
    let cur = opener.analysis?.lab ?? [50, 0, 0];
    while (pool.length) {
      let bi = 0, bd = Infinity;
      pool.forEach((p, i) => {
        const l = p.analysis?.lab ?? [50, 0, 0];
        const d = (l[0] - cur[0]) ** 2 * 0.5 + (l[1] - cur[1]) ** 2 + (l[2] - cur[2]) ** 2;
        if (d < bd) [bi, bd] = [i, d];
      });
      const next = pool.splice(bi, 1)[0];
      middle.push(next);
      cur = next.analysis?.lab ?? cur;
    }
  }

  const out = [opener, ...middle, ...(closer ? [closer] : [])];
  // Rhythm pass: fix look-alikes side by side and runs of the same shot scale with small,
  // local swaps, so the time order (the story) stays intact.
  const analyses = chosen.map((p) => p.analysis!).filter((a) => a?.grid);
  const similar = analyses.length > 2 ? sameSceneFor(analyses) * 1.6 : 0;
  // Same scene: the same moment of the album, or simply look-alikes.
  const sim = (a: Photo, b: Photo) =>
    (sceneOf?.has(a) && sceneOf.get(a) === sceneOf.get(b)) ||
    (!!a?.analysis?.grid && !!b?.analysis?.grid && distance(a.analysis!, b.analysis!) < similar);
  const scaleOf = (p: Photo) => (closeness(p) > 0.55 ? 'close' : closeness(p) < 0.35 ? 'wide' : 'mid');
  const bad = (i: number) =>
    (i > 0 && sim(out[i - 1], out[i])) ? 2 : i > 1 && scaleOf(out[i]) === scaleOf(out[i - 1]) && scaleOf(out[i]) === scaleOf(out[i - 2]) ? 1 : 0;
  // One pass, neighbours only: a look-alike next to its twin swaps with the following photo (or the
  // one after); a third same-scale shot in a row does too, but only if that adds no new problem.
  // Photos may trade places to break up look-alikes, but none strays more than 3 places from its
  // moment in the story; the opening and closing shots stay put.
  const home = new Map(out.map((p, i) => [p, i]));
  const fixed = new Set<Photo>([opener, ...(closer ? [closer] : [])]);
  const canSit = (p: Photo, at: number) => !fixed.has(p) && Math.abs(home.get(p)! - at) <= 3;
  const around = (ks: number[]) => [...new Set(ks.flatMap((k) => [k, k + 1]))].filter((k) => k > 0 && k < out.length).reduce((t, k) => t + bad(k), 0);
  const tryMove = (k: number) => {
    if (k <= 0) return false;
    for (const j of [k + 1, k + 2, k - 1, k - 2, k - 3]) {
      if (j <= 0 || j >= out.length || !canSit(out[k], j) || !canSit(out[j], k)) continue;
      const before = around([k, j]);
      [out[k], out[j]] = [out[j], out[k]];
      if (around([k, j]) < before) return true;
      [out[k], out[j]] = [out[j], out[k]];
    }
    return false;
  };
  for (let pass = 0; pass < 3; pass++) for (let i = 1; i < out.length; i++) if (bad(i)) tryMove(i) || tryMove(i - 1);
  // The ending matters most: if the closing shot still follows its own scene, reach a little
  // further back for the photo before it.
  const n = out.length;
  if (n > 4 && bad(n - 1) === 2)
    for (let j = n - 3; j >= Math.max(1, n - 6); j--) {
      const before = around([j, n - 2]);
      [out[j], out[n - 2]] = [out[n - 2], out[j]];
      if (around([j, n - 2]) < before) break;
      [out[j], out[n - 2]] = [out[n - 2], out[j]];
    }
  return out;
}

/**
 * Tilt worth fixing: clearly off level → fix; plausible, big (maybe a deliberate Dutch angle, and
 * straightening crops a lot) or only weakly supported → ask the user.
 */
export function tiltVerdict(a?: Analysis): 'fix' | 'ask' | null {
  if (!a?.tilt || a.tiltConfidence == null) return null;
  const t = Math.abs(a.tilt), c = a.tiltConfidence;
  if (t < 0.6 || t > 25) return null;
  // Only a horizon (or strong, agreeing landscape lines) is trusted to straighten automatically;
  // angles read from objects might be the object leaning, so those are always asked.
  if (a.tiltSource === 'horizon' && c >= 0.45 && t <= 12) return 'fix';
  if (a.tiltSource === 'lines' && c >= 0.6 && t <= 12) return 'fix';
  if (c >= 0.45 || (c >= 0.3 && t >= 1)) return 'ask';
  return null;
}

/**
 * Questions for the user where the scores alone can't decide: near-tied similar shots among the
 * picks, and tilts that might be intentional.
 */
export function buildDecisions(photos: Photo[], picks: string[]): Decision[] {
  const out: Decision[] = [];
  const picked = new Set(picks);
  const groups = new Map<string, Photo[]>();
  for (const p of photos) {
    const g = p.analysis?.groupId;
    if (g && !p.analysis!.reject) groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  for (const [groupId, ps] of groups) {
    if (ps.length < 2 || !ps.some((p) => picked.has(p.id))) continue;
    const ranked = [...ps].sort((a, b) => b.analysis!.score - a.analysis!.score);
    const top = ranked[0].analysis!.score;
    const close = ranked.filter((p) => top - p.analysis!.score <= 6).slice(0, 4);
    if (close.length > 1) out.push({ id: `pick_${groupId}`, kind: 'pick', groupId, options: close.map((p) => p.id), suggested: ranked[0].id });
  }
  for (const id of picks) {
    const p = photos.find((x) => x.id === id);
    if (p && !p.straightened && tiltVerdict(p.analysis) === 'ask')
      out.push({ id: `tilt_${id}`, kind: 'straighten', photoId: id, angle: p.analysis!.tilt! });
  }
  return out;
}
