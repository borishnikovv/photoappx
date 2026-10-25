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
  const graphic = (t.flatness > 0.4 && t.coverage > 0.75) || /screen ?shot|screen_?record/i.test(p.name);
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
    embedding: c?.embedding,
    aesthetic: c?.aesthetic,
    style: c?.style,
    faces,
    score: Math.round(Math.min(1, Math.max(0, s)) * 100 * (reject ? 0.5 : 1)),
    tilt: t.tilt,
    tiltConfidence: t.tiltConfidence,
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

/** Chooses the strongest distinct photos and orders them, hero first. */
export function curate(photos: Photo[], count: number, seq: Sequence): string[] {
  const pool = photos
    .filter((p) => p.analysis && !p.analysis.reject && p.analysis.groupBest !== false)
    .sort((a, b) => b.analysis!.score - a.analysis!.score);
  const chosen: Photo[] = [];
  for (const p of pool) {
    if (chosen.length >= count) break;
    if (chosen.some((q) => cosine(q.analysis!.embedding, p.analysis!.embedding) > 0.92)) continue;
    chosen.push(p);
  }
  return sequence(chosen, seq).map((p) => p.id);
}

export function sequence(chosen: Photo[], seq: Sequence): Photo[] {
  if (chosen.length < 3) return chosen;
  // Hero: a strong opener, wide frames slightly favoured since they can span slides.
  const heroScore = (p: Photo) => (p.analysis?.score ?? 0) + (['landscape', 'pano'].includes(photoOrientation(p)) ? 6 : 0);
  const hero = chosen.reduce((a, b) => (heroScore(b) > heroScore(a) ? b : a));
  const rest = chosen.filter((p) => p !== hero);
  if (seq === 'story') return [hero, ...rest.sort((a, b) => a.date - b.date)];
  // Color flow: walk to the nearest mean color each step, so tones blend slide to slide.
  const out = [hero];
  while (rest.length) {
    const cur = out[out.length - 1].analysis?.lab ?? [50, 0, 0];
    let bi = 0, bd = Infinity;
    rest.forEach((p, i) => {
      const l = p.analysis?.lab ?? [50, 0, 0];
      const d = (l[0] - cur[0]) ** 2 * 0.5 + (l[1] - cur[1]) ** 2 + (l[2] - cur[2]) ** 2;
      if (d < bd) [bi, bd] = [i, d];
    });
    out.push(rest.splice(bi, 1)[0]);
  }
  return out;
}

/** Tilt worth fixing: clearly off level, but not so far it's probably a deliberate Dutch angle. */
export function tiltVerdict(a?: Analysis): 'fix' | 'ask' | null {
  if (!a?.tilt || a.tiltConfidence == null) return null;
  const t = Math.abs(a.tilt);
  if (t < 0.8 || t > 9) return null;
  if (a.tiltConfidence >= 0.45) return 'fix';
  if (a.tiltConfidence >= 0.25 && t >= 1.2) return 'ask';
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
