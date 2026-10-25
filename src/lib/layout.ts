import type { Carousel, Family, Item, Orientation, Photo, Section, StyleOptions } from '../types';
import { SLIDE_H as H, SLIDE_W as W, fitBox, photoOrientation, rng, sourceRect, uid } from './geometry';

type Spec = Omit<Item, 'id'>;
type Build = (ps: Photo[], r: () => number, o: StyleOptions) => Spec[];

export interface Template {
  id: string;
  label: string;
  family: Family | 'base';
  span: number;
  slots: Orientation[][];
  weight: number;
  /** Good opener for the first slide. */
  hero?: boolean;
  build: Build;
}

const ANY: Orientation[] = ['portrait', 'square', 'landscape', 'pano'];
const TALL: Orientation[] = ['portrait', 'square'];
const WIDE: Orientation[] = ['landscape', 'pano'];

const aspect = (p: Photo) => p.width / p.height;
const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];

/** Focal point: the center of the faces if any were found, else just above center. */
export function focalPoint(p: Photo) {
  const faces = p.analysis?.faces;
  if (faces?.length) {
    let fx = 0, fy = 0, wt = 0;
    for (const f of faces) {
      const a = f.w * f.h;
      fx += (f.x + f.w / 2) * a;
      fy += (f.y + f.h / 2) * a;
      wt += a;
    }
    return { fx: fx / wt, fy: fy / wt };
  }
  return { fx: 0.5, fy: photoOrientation(p) === 'portrait' ? 0.45 : 0.5 };
}

function mk(p: Photo, x: number, y: number, w: number, h: number, extra: Partial<Spec> = {}): Spec {
  return {
    photoId: p.id,
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
    crop: { ...focalPoint(p), zoom: 1 },
    border: 0,
    shadow: false,
    z: 0,
    ...extra,
  };
}

/** A framed photo sized to its own aspect, centered on (cx, cy). */
function framed(p: Photo, cx: number, cy: number, maxW: number, maxH: number, extra: Partial<Spec> = {}) {
  const b = fitBox(aspect(p), maxW, maxH);
  return mk(p, cx - b.w / 2, cy - b.h / 2, b.w, b.h, extra);
}

export const TEMPLATES: Template[] = [
  {
    id: 'full', label: 'Full bleed', family: 'base', span: 1, slots: [TALL], weight: 0.9, hero: true,
    build: ([a]) => [mk(a, 0, 0, W, H)],
  },
  {
    id: 'framed', label: 'Framed', family: 'gallery', span: 1, slots: [ANY], weight: 1,
    build: ([a], r) => {
      const m = pick(r, [90, 120, 150]);
      return [framed(a, W / 2, H / 2 - 20, W - 2 * m, H - 2.6 * m)];
    },
  },
  {
    id: 'framed-low', label: 'Off-center', family: 'gallery', span: 1, slots: [TALL], weight: 0.6,
    build: ([a], r) => {
      const b = fitBox(aspect(a), 620, 820);
      const left = r() > 0.5;
      return [mk(a, left ? 110 : W - 110 - b.w, H - 150 - b.h, b.w, b.h)];
    },
  },
  {
    id: 'duo-stack', label: 'Stacked pair', family: 'gallery', span: 1, slots: [WIDE, WIDE], weight: 0.8,
    build: ([a, b]) => {
      const gap = 40;
      let w = W - 220;
      const total = w / aspect(a) + w / aspect(b) + gap;
      if (total > H - 220) w *= (H - 220 - gap) / (total - gap);
      const ha = w / aspect(a), hb = w / aspect(b);
      const y0 = (H - ha - hb - gap) / 2;
      return [mk(a, (W - w) / 2, y0, w, ha), mk(b, (W - w) / 2, y0 + ha + gap, w, hb)];
    },
  },
  {
    id: 'duo-side', label: 'Staggered pair', family: 'gallery', span: 1, slots: [TALL, TALL], weight: 0.9,
    build: ([a, b]) => {
      const col = (W - 160 - 36) / 2;
      return [framed(a, 80 + col / 2, H / 2 - 70, col, 720), framed(b, 80 + col * 1.5 + 36, H / 2 + 70, col, 720)];
    },
  },
  {
    id: 'pano2', label: 'Panorama ×2', family: 'pano', span: 2, slots: [WIDE], weight: 1.3, hero: true,
    build: ([a]) => [mk(a, 0, 0, 2 * W, H)],
  },
  {
    id: 'pano2-framed', label: 'Framed panorama ×2', family: 'pano', span: 2, slots: [WIDE], weight: 0.9,
    build: ([a], r) => [framed(a, W, H / 2, 2 * W - 2 * pick(r, [100, 140]), H - 420)],
  },
  {
    id: 'pano3', label: 'Panorama ×3', family: 'pano', span: 3, slots: [['pano']], weight: 1.4, hero: true,
    build: ([a]) => [mk(a, 0, 0, 3 * W, H)],
  },
  {
    id: 'pano3-framed', label: 'Framed panorama ×3', family: 'pano', span: 3, slots: [['pano']], weight: 0.8,
    build: ([a]) => [framed(a, 1.5 * W, H / 2, 3 * W - 240, H - 400)],
  },
  {
    id: 'inset', label: 'Inset on panorama', family: 'layered', span: 2, slots: [WIDE, TALL], weight: 1.2, hero: true,
    build: ([a, b], r) => {
      const box = fitBox(aspect(b), 440 + Math.round(r() * 60), 640);
      const low = r() > 0.4;
      return [
        mk(a, 0, 0, 2 * W, H),
        mk(b, W - box.w / 2, low ? H - box.h - 130 : 130, box.w, box.h, { border: 12, shadow: true, z: 1 }),
      ];
    },
  },
  {
    id: 'corner', label: 'Corner inset', family: 'layered', span: 1, slots: [TALL, ANY], weight: 0.8,
    build: ([a, b]) => {
      const box = fitBox(aspect(b), 360, 460);
      return [mk(a, 0, 0, W, H), mk(b, W - box.w - 70, H - box.h - 80, box.w, box.h, { border: 10, shadow: true, z: 1 })];
    },
  },
  {
    id: 'offset', label: 'Offset across seam', family: 'layered', span: 2, slots: [ANY, ANY], weight: 1,
    build: ([a, b], r) => {
      const A = fitBox(aspect(a), 820, 980);
      const B = fitBox(aspect(b), 760, 900);
      const flip = r() > 0.5;
      return [
        mk(a, 100, flip ? H - A.h - 130 : 130, A.w, A.h),
        mk(b, 920, flip ? 130 : H - B.h - 130, B.w, B.h, { shadow: true, z: 1 }),
      ];
    },
  },
  {
    id: 'overlap', label: 'Overlap pair', family: 'layered', span: 1, slots: [TALL, TALL], weight: 0.7,
    build: ([a, b]) => {
      const A = fitBox(aspect(a), 620, 860);
      const B = fitBox(aspect(b), 500, 700);
      return [mk(a, 80, 110, A.w, A.h), mk(b, W - 80 - B.w, H - B.h - 110, B.w, B.h, { shadow: true, z: 1 })];
    },
  },
  {
    id: 'spill', label: 'Spill over', family: 'gallery', span: 2, slots: [TALL, WIDE], weight: 0.9,
    build: ([a, b]) => {
      const A = fitBox(aspect(a), 620, 1000);
      const B = fitBox(aspect(b), 1220, 900);
      return [mk(a, 110, (H - A.h) / 2 - 60, A.w, A.h), mk(b, 2 * W - 120 - B.w, (H - B.h) / 2 + 80, B.w, B.h)];
    },
  },
  {
    id: 'strip3', label: 'Film strip', family: 'gallery', span: 2, slots: [TALL, TALL, TALL], weight: 0.9,
    build: (ps) => {
      const gap = 60;
      const boxes = ps.map((p) => fitBox(aspect(p), 560, 760));
      let x = (2 * W - boxes.reduce((s, b) => s + b.w, 0) - gap * 2) / 2;
      return ps.map((p, i) => {
        const it = mk(p, x, (H - boxes[i].h) / 2, boxes[i].w, boxes[i].h);
        x += boxes[i].w + gap;
        return it;
      });
    },
  },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id)!;

/** Assign photos to a template's slots. The first candidate must be used, to keep the sequence. */
function assign(t: Template, cands: Photo[]): Photo[] | null {
  const used = new Set<number>();
  const out: Photo[] = [];
  const rec = (slot: number): boolean => {
    if (slot === t.slots.length) return used.has(0);
    for (let i = 0; i < cands.length; i++) {
      if (used.has(i) || !t.slots[slot].includes(photoOrientation(cands[i]))) continue;
      used.add(i);
      out.push(cands[i]);
      if (rec(slot + 1)) return true;
      used.delete(i);
      out.pop();
    }
    return false;
  };
  return rec(0) ? out : null;
}

export function buildSection(t: Template, ps: Photo[], r: () => number, o: StyleOptions): Section {
  const items = t.build(ps, r, o).map((s) => ({ ...s, id: uid('it') }));
  const sec: Section = { id: uid('sec'), template: t.id, span: t.span, photoIds: ps.map((p) => p.id), items };
  keepFacesOffSeams(sec, ps);
  return sec;
}

/**
 * Nudges the crop of items that cross a slide edge so faces land fully on one slide.
 */
export function keepFacesOffSeams(sec: Section, ps: Photo[]) {
  const byId = new Map(ps.map((p) => [p.id, p]));
  for (const it of sec.items) {
    const p = byId.get(it.photoId);
    const faces = p?.analysis?.faces;
    if (!p || !faces?.length) continue;
    const seams: number[] = [];
    for (let s = W; s < sec.span * W; s += W) if (s > it.x && s < it.x + it.w) seams.push(s);
    if (!seams.length) continue;
    const cost = (fx: number) => {
      const { sx, sw } = sourceRect(p, { ...it, crop: { ...it.crop, fx } });
      let c = 0;
      for (const f of faces) {
        const l = it.x + ((f.x - sx) / sw) * it.w;
        const rr = it.x + ((f.x + f.w - sx) / sw) * it.w;
        for (const s of seams) if (l < s + 20 && rr > s - 20) c += Math.min(s + 20 - l, rr - (s - 20));
      }
      return c + Math.abs(fx - it.crop.fx) * 50;
    };
    let best = it.crop.fx, bestC = cost(best);
    for (let fx = 0; fx <= 1.0001; fx += 0.02) {
      const c = cost(fx);
      if (c < bestC) [best, bestC] = [fx, c];
    }
    it.crop.fx = best;
  }
}

export interface Emphasis {
  name: string;
  boost: Partial<Record<Family | 'base', number>>;
}

export const VARIANTS: Emphasis[] = [
  { name: 'Balanced', boost: {} },
  { name: 'Cinematic', boost: { pano: 2.2, layered: 1.4, gallery: 0.6 } },
  { name: 'Gallery', boost: { gallery: 2.2, base: 0.5 } },
];

export function generateCarousel(photos: Photo[], o: StyleOptions, seed: number, emph: Emphasis): Carousel {
  const r = rng(seed);
  const queue = [...photos];
  const sections: Section[] = [];
  let slides = 0;
  let last = '';
  const allowed = TEMPLATES.filter((t) => t.family === 'base' || o.families[t.family]);

  while (queue.length && slides < o.maxSlides) {
    const left = o.maxSlides - slides;
    // Photos per slide we need from here on to fit everything in.
    const density = queue.length / left;
    const options: { t: Template; ps: Photo[]; w: number }[] = [];
    for (const t of allowed) {
      if (t.span > left) continue;
      const ps = assign(t, queue.slice(0, 5));
      if (!ps) continue;
      let w = t.weight * (emph.boost[t.family] ?? 1);
      if (t.id === last) w *= 0.15;
      if (sections.length === 0) w *= t.hero ? 3 : 0.4;
      const perSlide = ps.length / t.span;
      if (density > 1) w *= Math.pow(perSlide, 1.5);
      else if (density < 0.6) w *= t.span > 1 ? 1.6 : 0.8;
      options.push({ t, ps, w });
    }
    if (!options.length) {
      // Nothing fits this photo with the chosen styles: fall back to a framed or full-bleed slide.
      const t = templateById(o.families.gallery || photoOrientation(queue[0]) === 'landscape' ? 'framed' : 'full');
      options.push({ t, ps: [queue[0]], w: 1 });
    }
    let x = r() * options.reduce((s, c) => s + c.w, 0);
    const choice = options.find((c) => (x -= c.w) <= 0) ?? options[options.length - 1];
    sections.push(buildSection(choice.t, choice.ps, r, o));
    for (const p of choice.ps) queue.splice(queue.indexOf(p), 1);
    slides += choice.t.span;
    last = choice.t.id;
  }
  return { id: uid('car'), name: emph.name, seed, sections };
}

/** Templates that can hold exactly these photos, for "shuffle layout". */
export function compatibleTemplates(ps: Photo[], o: StyleOptions) {
  return TEMPLATES.filter(
    (t) => (t.family === 'base' || o.families[t.family]) && t.slots.length === ps.length && assign(t, ps),
  );
}

export function rebuildSection(sec: Section, t: Template, ps: Photo[], o: StyleOptions, seed: number): Section {
  const ordered = assign(t, ps) ?? ps;
  const built = buildSection(t, ordered, rng(seed), o);
  // Photos bridging into the next slide belong to the seam, not the layout, so they survive a re-roll.
  return { ...built, id: sec.id, items: [...built.items, ...(sec.items?.filter((i) => i.bridge) ?? [])] };
}

/** Face rectangles of an item, in canvas coordinates. */
function facesOnCanvas(it: Item & { ax: number }, p: Photo) {
  const { sx, sy, sw, sh } = sourceRect(p, it);
  return (p.analysis?.faces ?? []).map((f) => ({
    x0: it.ax + ((f.x - sx) / sw) * it.w,
    x1: it.ax + ((f.x + f.w - sx) / sw) * it.w,
    y0: it.y + ((f.y - sy) / sh) * it.h,
    y1: it.y + ((f.y + f.h - sy) / sh) * it.h,
  }));
}

/**
 * The SCRL move: wherever nothing crosses the cut between two slides, lay a framed photo across
 * it, so swiping reads as one continuous canvas. Placed to avoid covering faces underneath.
 */
export function addBridges(c: Carousel, reserve: Photo[], byId: Map<string, Photo>, seed: number): Carousel {
  const r = rng(seed ^ 0x5eed);
  const pool = [...reserve];
  const sections = c.sections.map((s) => ({ ...s, items: s.items.filter((i) => !i.bridge) }));
  const starts: number[] = [];
  let n = 0;
  for (const s of sections) {
    starts.push(n);
    n += s.span;
  }
  const abs = () =>
    sections.flatMap((s, si) => s.items.map((it) => ({ ...it, ax: starts[si] * W + it.x })));
  let flip = r() > 0.5;
  for (let k = 1; k < n; k++) {
    const seam = k * W;
    if (abs().some((it) => it.ax < seam - 60 && it.ax + it.w > seam + 60)) continue;
    const owner = starts.findIndex((st, i) => st + sections[i].span === k);
    if (owner < 0 || !pool.length) continue;
    // Smaller, taller frames sit best on a seam; fall back to whatever is left.
    const pi = Math.max(0, pool.findIndex((p) => ['portrait', 'square'].includes(photoOrientation(p))));
    const p = pool.splice(pi, 1)[0];
    const wide = ['landscape', 'pano'].includes(photoOrientation(p));
    const box = fitBox(aspect(p), wide ? 540 + r() * 60 : 380 + r() * 90, wide ? 420 : 620);
    const near = abs().filter((it) => it.ax < seam + box.w && it.ax + it.w > seam - box.w);
    const faces = near.flatMap((it) => facesOnCanvas(it, byId.get(it.photoId)!));
    // Other framed/floating photos: covering one makes a slide look cluttered. Backgrounds are fine.
    const frames = near
      .filter((it) => !(it.w >= W && it.h >= H))
      .map((it) => ({ x0: it.ax - 30, x1: it.ax + it.w + 30, y0: it.y - 30, y1: it.y + it.h + 30, wt: it.z > 0 || it.bridge ? 4 : 1 }));
    const x = seam - box.w / 2 + (r() - 0.5) * 100;
    const overlap = (y: number, q: { x0: number; x1: number; y0: number; y1: number }) =>
      Math.max(0, Math.min(x + box.w, q.x1) - Math.max(x, q.x0)) * Math.max(0, Math.min(y + box.h, q.y1) - Math.max(y, q.y0));
    const ys = [110, 300, (H - box.h) / 2, H - box.h - 300, H - box.h - 110].map((y) => Math.max(60, Math.min(H - box.h - 60, y)));
    const cost = (y: number, i: number) =>
      faces.reduce((c2, f) => c2 + 3 * overlap(y, f), 0) +
      frames.reduce((c2, f) => c2 + f.wt * overlap(y, f), 0) +
      // Prefer alternating high/low along the carousel for rhythm.
      (i === 2 ? 4000 : 0) + ((flip ? i < 2 : i > 2) ? 0 : 3000);
    const y = ys.map((yy, i) => [yy, cost(yy, i)] as const).sort((a, b) => a[1] - b[1])[0][0];
    flip = !flip;
    sections[owner].items.push({
      ...mk(p, x - starts[owner] * W, y, box.w, box.h, { border: 12, shadow: true, z: 5, bridge: true }),
      id: uid('it'),
    });
  }
  return { ...c, sections };
}
