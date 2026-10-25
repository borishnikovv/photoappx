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

/**
 * A frame shape for a photo laid on top: classic ratios (1:1, 4:3, 3:2, 4:5, 3:4, 16:9) for quiet
 * variety, but only ones close enough to the photo's own shape that the crop never loses it.
 */
const FRAMES_TALL = [4 / 5, 3 / 4, 1, 2 / 3];
const FRAMES_WIDE = [4 / 3, 3 / 2, 1, 16 / 9];
export function frameAspect(p: Photo, r: () => number) {
  const a = aspect(p);
  const opts = (a < 1 ? FRAMES_TALL : FRAMES_WIDE).filter((x) => Math.abs(Math.log(x / a)) < 0.3);
  return opts.length ? pick(r, opts) : a;
}

/** How a photo laid on top of another looks: clean edges by default, or a framed print. */
const ov = (o: StyleOptions, z = 1): Partial<Spec> =>
  o.overlay === 'framed' ? { border: 12, shadow: true, z } : { border: 0, shadow: false, z };

type Rect = { x0: number; x1: number; y0: number; y1: number };
const area = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/**
 * What it costs to cover part of a photo: its busy-ness there (sky, water, a plain wall are cheap;
 * subjects and detail are expensive) and, above all, any faces. `rect` and `it` share coordinates.
 */
function coverCost(rect: Rect, it: { x: number; y: number; w: number; h: number; crop: Item['crop'] }, p: Photo) {
  const hit = area(rect, { x0: it.x, x1: it.x + it.w, y0: it.y, y1: it.y + it.h });
  if (!hit) return 0;
  const { sx, sy, sw, sh } = sourceRect(p, it);
  const toPhoto = (x: number, y: number) => [sx + ((x - it.x) / it.w) * sw, sy + ((y - it.y) / it.h) * sh];
  const [u0, v0] = toPhoto(Math.max(rect.x0, it.x), Math.max(rect.y0, it.y));
  const [u1, v1] = toPhoto(Math.min(rect.x1, it.x + it.w), Math.min(rect.y1, it.y + it.h));
  const detail = p.analysis?.detail;
  let busy = 0.5;
  if (detail) {
    let sum = 0, n = 0;
    for (let cy = Math.floor(v0 * 8); cy <= Math.min(7, Math.floor(v1 * 8 - 1e-6)); cy++)
      for (let cx = Math.floor(u0 * 8); cx <= Math.min(7, Math.floor(u1 * 8 - 1e-6)); cx++) {
        sum += detail[cy * 8 + cx];
        n++;
      }
    busy = n ? sum / n : 0.5;
  }
  let faces = 0;
  for (const f of p.analysis?.faces ?? []) {
    const fr = { x0: f.x, x1: f.x + f.w, y0: f.y, y1: f.y + f.h };
    faces += area(fr, { x0: u0, x1: u1, y0: v0, y1: v1 }) / Math.max(1e-6, f.w * f.h);
  }
  return hit * (0.15 + busy) + faces * 4e6;
}

/** Best spot for a photo laid over `bg`: calm areas first, then the preferred rhythm (`bias`). */
function placeOver(bg: Spec, bgPhoto: Photo, box: { w: number; h: number }, xs: number[], ys: number[], bias: (x: number, y: number) => number) {
  let best = { x: xs[0], y: ys[0] }, bestC = Infinity;
  for (const x of xs)
    for (const y of ys) {
      const c = coverCost({ x0: x, x1: x + box.w, y0: y, y1: y + box.h }, bg, bgPhoto) + bias(x, y);
      if (c < bestC) [best, bestC] = [{ x, y }, c];
    }
  return best;
}

/** Positions that straddle a cut at `seam`, from mostly-left to mostly-right of it. */
const straddle = (seam: number, w: number) => [0.25, 0.4, 0.5, 0.6, 0.75].map((f) => seam - w * f);
/** Vertical positions from high to low, keeping a margin. */
const heights = (h: number, m = 90) => [m, m + (H - h - 2 * m) * 0.25, (H - h) / 2, m + (H - h - 2 * m) * 0.75, H - h - m];

/** A framed photo sized to its own aspect, centered on (cx, cy). */
function framed(p: Photo, cx: number, cy: number, maxW: number, maxH: number, extra: Partial<Spec> = {}) {
  const b = fitBox(aspect(p), maxW, maxH);
  return mk(p, cx - b.w / 2, cy - b.h / 2, b.w, b.h, extra);
}

export const TEMPLATES: Template[] = [
  // ---- Spreads: one photo as a backdrop across slides, others laid on its calm areas ----
  {
    id: 'spread2', label: 'Spread ×2', family: 'spread', span: 2, slots: [WIDE, TALL], weight: 1.4, hero: true,
    build: ([a, b], r, o) => {
      const bg = mk(a, 0, 0, 2 * W, H);
      const box = fitBox(frameAspect(b, r), W * (0.62 + r() * 0.1), H * (0.68 + r() * 0.12));
      const high = r() > 0.5;
      const at = placeOver(bg, a, box, straddle(W, box.w), heights(box.h), (_, y) => (high ? y : H - box.h - y) * 40);
      return [bg, mk(b, at.x, at.y, box.w, box.h, ov(o))];
    },
  },
  {
    id: 'spread3', label: 'Spread ×3', family: 'spread', span: 3, slots: [WIDE, TALL, TALL], weight: 1.5, hero: true,
    build: ([a, b, c], r, o) => {
      // Sometimes the backdrop stops short and the last frame bridges it into the plain ground.
      const bgW = r() > 0.5 ? 3 * W : Math.round(W * (2.55 + r() * 0.25));
      const bg = mk(a, 0, 0, bgW, H);
      const B = fitBox(frameAspect(b, r), W * (0.58 + r() * 0.1), H * (0.64 + r() * 0.12));
      const C = fitBox(frameAspect(c, r), W * (0.58 + r() * 0.1), H * (0.64 + r() * 0.12));
      const high = r() > 0.5;
      const pb = placeOver(bg, a, B, straddle(W, B.w), heights(B.h), (_, y) => (high ? y : H - B.h - y) * 40);
      const pc = placeOver(bg, a, C, straddle(2 * W, C.w), heights(C.h), (_, y) => (high ? H - C.h - y : y) * 40);
      return [bg, mk(b, pb.x, pb.y, B.w, B.h, ov(o)), mk(c, pc.x, pc.y, C.w, C.h, ov(o, 2))];
    },
  },
  {
    id: 'spread3-wide', label: 'Landscape over landscape', family: 'spread', span: 3, slots: [WIDE, WIDE], weight: 1.2, hero: true,
    build: ([a, b], r, o) => {
      const bg = mk(a, 0, 0, 3 * W, H);
      const box = fitBox(frameAspect(b, r), W * (1.25 + r() * 0.25), H * 0.7);
      const seam = r() > 0.5 ? W : 2 * W;
      const at = placeOver(bg, a, box, straddle(seam, box.w), heights(box.h, 110), () => 0);
      return [bg, mk(b, at.x, at.y, box.w, box.h, ov(o))];
    },
  },
  {
    id: 'band2', label: '16:9 band', family: 'spread', span: 2, slots: [WIDE, ANY], weight: 1.1,
    build: ([a, b], r, o) => {
      // A cinematic 16:9 band across the cut with a little ground above and below, and one quieter
      // frame (1:1 or 4:3) resting on a corner of it, half on the photo, half on the ground.
      const bh = Math.round(H * (0.66 + r() * 0.1)), bw = Math.min(2 * W - 120, Math.round((bh * 16) / 9));
      const bx = Math.round((2 * W - bw) / 2 + (r() - 0.5) * 120), by = Math.round((H - bh) / 2 + (r() - 0.5) * 80);
      const band = mk(a, bx, by, bw, bh);
      const box = fitBox(aspect(b) < 1 ? 1 : 4 / 3, W * (0.55 + r() * 0.1), H * 0.56);
      const corners = [
        { x: bx - box.w * 0.3, y: by - box.h * 0.35 },
        { x: bx + bw - box.w * 0.7, y: by - box.h * 0.35 },
        { x: bx - box.w * 0.3, y: by + bh - box.h * 0.65 },
        { x: bx + bw - box.w * 0.7, y: by + bh - box.h * 0.65 },
      ].map((p) => ({ x: Math.max(50, Math.min(2 * W - box.w - 50, p.x)), y: Math.max(50, Math.min(H - box.h - 50, p.y)) }));
      const at = corners
        .map((p) => ({ ...p, c: coverCost({ x0: p.x, x1: p.x + box.w, y0: p.y, y1: p.y + box.h }, band, a) }))
        .sort((p, q) => p.c - q.c)[0];
      return [band, mk(b, at.x, at.y, box.w, box.h, ov(o))];
    },
  },
  {
    id: 'band3', label: '16:9 band ×3', family: 'spread', span: 3, slots: [WIDE, ANY, ANY], weight: 1.1,
    build: ([a, b, c], r, o) => {
      // The band runs through the middle slide; small frames sit on its two ends, crossing the cuts.
      const bh = Math.round(H * (0.72 + r() * 0.12)), bw = Math.min(3 * W - 200, Math.round((bh * 16) / 9));
      const bx = Math.round((3 * W - bw) / 2), by = Math.round((H - bh) / 2);
      const band = mk(a, bx, by, bw, bh);
      const B = fitBox(aspect(b) < 1 ? 1 : 4 / 3, W * 0.56, H * 0.52);
      const C = fitBox(aspect(c) < 1 ? 4 / 5 : 4 / 3, W * 0.56, H * 0.6);
      const up = r() > 0.5;
      const pb = { x: W - B.w * 0.5, y: up ? 70 : H - B.h - 70 };
      const pc = { x: 2 * W - C.w * 0.5, y: up ? H - C.h - 70 : 70 };
      return [band, mk(b, pb.x, pb.y, B.w, B.h, ov(o)), mk(c, pc.x, pc.y, C.w, C.h, ov(o, 2))];
    },
  },
  {
    id: 'cascade', label: 'Cascade', family: 'spread', span: 2, slots: [TALL, TALL, TALL], weight: 1.1,
    build: (ps, r, o) => {
      // Three portraits stepping high-low-high, each overlapping the last, the middle one on the cut.
      const boxes = ps.map((p, i) => fitBox(frameAspect(p, r), W * 0.62, H * (i % 2 ? 0.7 : 0.6)));
      const lap = 70 + r() * 50;
      const total = boxes.reduce((s, b) => s + b.w, 0) - 2 * lap;
      let x = W - boxes[0].w + lap - boxes[1].w / 2 + (r() - 0.5) * 60;
      x = Math.max(60, Math.min(2 * W - total - 60, x));
      const up = r() > 0.5;
      return ps.map((p, i) => {
        const b = boxes[i];
        const y = (i % 2 === 0) === up ? 100 + r() * 60 : H - b.h - 100 - r() * 60;
        const it = mk(p, x, y, b.w, b.h, ov(o, i));
        x += b.w - lap;
        return it;
      });
    },
  },
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
    build: ([a, b], r, o) => {
      const box = fitBox(aspect(b), 440 + Math.round(r() * 60), 640);
      const low = r() > 0.4;
      return [
        mk(a, 0, 0, 2 * W, H),
        mk(b, W - box.w / 2, low ? H - box.h - 130 : 130, box.w, box.h, ov(o)),
      ];
    },
  },
  {
    id: 'corner', label: 'Corner inset', family: 'layered', span: 1, slots: [TALL, ANY], weight: 0.8,
    build: ([a, b], _r, o) => {
      const bg = mk(a, 0, 0, W, H);
      const box = fitBox(aspect(b), 400, 520);
      const at = placeOver(bg, a, box, [70, (W - box.w) / 2, W - box.w - 70], heights(box.h, 80), () => 0);
      return [bg, mk(b, at.x, at.y, box.w, box.h, ov(o))];
    },
  },
  {
    id: 'offset', label: 'Offset across seam', family: 'layered', span: 2, slots: [ANY, ANY], weight: 1,
    build: ([a, b], r, o) => {
      const A = fitBox(aspect(a), 820, 980);
      const B = fitBox(aspect(b), 760, 900);
      const flip = r() > 0.5;
      return [
        mk(a, 100, flip ? H - A.h - 130 : 130, A.w, A.h),
        mk(b, 920, flip ? 130 : H - B.h - 130, B.w, B.h, ov(o)),
      ];
    },
  },
  {
    id: 'overlap', label: 'Overlap pair', family: 'layered', span: 1, slots: [TALL, TALL], weight: 0.7,
    build: ([a, b], _r, o) => {
      const A = fitBox(aspect(a), 620, 860);
      const B = fitBox(aspect(b), 500, 700);
      return [mk(a, 80, 110, A.w, A.h), mk(b, W - 80 - B.w, H - B.h - 110, B.w, B.h, ov(o))];
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

const labDist = (a: Photo, b: Photo) => {
  const x = a.analysis?.lab, y = b.analysis?.lab;
  return x && y ? Math.hypot((x[0] - y[0]) * 0.5, x[1] - y[1], x[2] - y[2]) : 50;
};

/** Assign photos to a template's slots. The first candidate must be used, to keep the sequence. */
function assign(t: Template, cands: Photo[]): Photo[] | null {
  // Spreads: photos laid on a backdrop should belong to it, so try the closest colors first.
  if (t.family === 'spread' && cands.length > 2) cands = [cands[0], ...cands.slice(1).sort((a, b) => labDist(a, cands[0]) - labDist(b, cands[0]))];
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
 * What must not be sliced by a cut: faces if there are any, otherwise the photo's subject, taken
 * as the compact cluster of its most detailed cells (the cup, the cat, the motorcycle).
 */
function protectedBoxes(p: Photo): { x: number; y: number; w: number; h: number; wt: number }[] {
  const faces = p.analysis?.faces;
  if (faces?.length) return faces.map((f) => ({ ...f, wt: 1 }));
  const d = p.analysis?.detail;
  if (!d) return [];
  const max = Math.max(...d);
  if (max < 0.15) return [];
  let x0 = 8, x1 = 0, y0 = 8, y1 = 0, n = 0;
  d.forEach((v, i) => {
    if (v < 0.75 * max) return;
    const cx = i % 8, cy = (i / 8) | 0;
    x0 = Math.min(x0, cx); x1 = Math.max(x1, cx + 1); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy + 1); n++;
  });
  // Detail spread all over (texture, crowds) isn't a single subject.
  if ((x1 - x0) * (y1 - y0) > 30 || !n) return [];
  return [{ x: x0 / 8, y: y0 / 8, w: (x1 - x0) / 8, h: (y1 - y0) / 8, wt: 0.6 }];
}

/**
 * Keeps faces (or, failing those, the subject) from being sliced by a cut: first by moving the
 * crop, and for framed photos that show the whole picture, by sliding the frame a little.
 */
export function keepFacesOffSeams(sec: Section, ps: Photo[]) {
  const byId = new Map(ps.map((p) => [p.id, p]));
  for (const it of sec.items) {
    const p = byId.get(it.photoId);
    const boxes = p ? protectedBoxes(p) : [];
    if (!p || !boxes.length) continue;
    const seamsIn = (x: number) => {
      const out: number[] = [];
      for (let s2 = W; s2 < sec.span * W; s2 += W) if (s2 > x && s2 < x + it.w) out.push(s2);
      return out;
    };
    if (!seamsIn(it.x).length) continue;
    const cost = (fx: number, x: number) => {
      const { sx, sw } = sourceRect(p, { ...it, crop: { ...it.crop, fx } });
      let c = 0;
      for (const f of boxes) {
        const l = x + ((f.x - sx) / sw) * it.w;
        const rr = x + ((f.x + f.w - sx) / sw) * it.w;
        for (const s2 of seamsIn(x)) if (l < s2 + 20 && rr > s2 - 20) c += f.wt * Math.min(s2 + 20 - l, rr - (s2 - 20));
      }
      return c + Math.abs(fx - it.crop.fx) * 50 + Math.abs(x - it.x) * 0.3;
    };
    let best = { fx: it.crop.fx, x: it.x }, bestC = cost(best.fx, best.x);
    // Full-height backdrops stay put and pan; smaller frames may also slide up to a quarter slide.
    const shifts = it.h >= H - 2 ? [0] : [-0.25, -0.15, -0.08, 0, 0.08, 0.15, 0.25].map((f) => f * W);
    for (const dx of shifts)
      for (let fx = 0; fx <= 1.0001; fx += 0.02) {
        const x = Math.max(-it.w * 0.1, Math.min(sec.span * W - it.w * 0.9, it.x + dx));
        const c = cost(fx, x);
        if (c < bestC) [best, bestC] = [{ fx, x }, c];
      }
    it.crop.fx = best.fx;
    it.x = Math.round(best.x);
  }
}

export interface Emphasis {
  name: string;
  boost: Partial<Record<Family | 'base', number>>;
}

export const VARIANTS: Emphasis[] = [
  { name: 'Spread', boost: { spread: 2.6, layered: 0.9, gallery: 0.5 } },
  { name: 'Cinematic', boost: { pano: 2.2, spread: 1.4, layered: 1.2, gallery: 0.5 } },
  { name: 'Gallery', boost: { gallery: 2.2, spread: 0.8, base: 0.5 } },
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
      const ps = assign(t, queue.slice(0, t.family === 'spread' ? 7 : 5));
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

/**
 * The SCRL move: wherever nothing crosses the cut between two slides, lay a photo across it, so
 * swiping reads as one continuous canvas (unless that would crowd either slide). It goes where what's underneath is calm (sky, water,
 * plain ground), never over faces, and steps high/low along the carousel for rhythm.
 */
export function addBridges(c: Carousel, reserve: Photo[], byId: Map<string, Photo>, o: StyleOptions, seed: number): Carousel {
  const r = rng(seed ^ 0x5eed);
  const pool = [...reserve];
  const sections = c.sections.map((s) => ({ ...s, items: s.items.filter((i) => !i.bridge) }));
  const starts: number[] = [];
  let n = 0;
  for (const s of sections) {
    starts.push(n);
    n += s.span;
  }
  const abs = () => sections.flatMap((s, si) => s.items.map((it) => ({ ...it, x: starts[si] * W + it.x })));
  let high = r() > 0.5;
  for (let k = 1; k < n; k++) {
    const seam = k * W;
    if (abs().some((it) => it.x < seam - 60 && it.x + it.w > seam + 60)) continue;
    const owner = starts.findIndex((st, i) => st + sections[i].span === k);
    if (owner < 0 || !pool.length) continue;
    // Keep it minimal: a busy slide on either side gets a clean cut instead of one more photo.
    const onSlide = (j: number) => abs().filter((it) => it.x < (j + 1) * W - 20 && it.x + it.w > j * W + 20).length;
    if (onSlide(k - 1) > 2 || onSlide(k) > 2) continue;
    // Prefer a photo whose colors belong next to what's on either side of the cut.
    const near = abs().filter((it) => it.x < seam + W / 2 && it.x + it.w > seam - W / 2);
    const tone = near.map((it) => byId.get(it.photoId)!).filter(Boolean);
    const fit = (p: Photo) => (['portrait', 'square'].includes(photoOrientation(p)) ? 0 : 40) + (tone.length ? Math.min(...tone.map((q) => labDist(p, q))) : 0);
    const pi = pool.reduce((bi, p, i) => (fit(p) < fit(pool[bi]) ? i : bi), 0);
    const p = pool.splice(pi, 1)[0];
    const wide = ['landscape', 'pano'].includes(photoOrientation(p));
    const fa = frameAspect(p, r);
    const box = wide ? fitBox(fa, W * (1.0 + r() * 0.2), H * 0.55) : fitBox(fa, W * (0.56 + r() * 0.1), H * (0.62 + r() * 0.12));
    const cost = (x: number, y: number) => {
      const rect = { x0: x, x1: x + box.w, y0: y, y1: y + box.h };
      let c2 = 0;
      for (const it of near) {
        const big = it.w * it.h >= 0.5 * W * H;
        c2 += big ? coverCost(rect, it, byId.get(it.photoId)!) : 3 * area(rect, { x0: it.x - 30, x1: it.x + it.w + 30, y0: it.y - 30, y1: it.y + it.h + 30 });
      }
      return c2 + (high ? y : H - box.h - y) * 60;
    };
    let best = { x: seam - box.w / 2, y: 100 }, bestC = Infinity;
    for (const x of straddle(seam, box.w))
      for (const y of heights(box.h, 100)) {
        const c2 = cost(x, y);
        if (c2 < bestC) [best, bestC] = [{ x, y }, c2];
      }
    high = !high;
    sections[owner].items.push({ ...mk(p, best.x - starts[owner] * W, best.y, box.w, box.h, { ...ov(o, 5), bridge: true }), id: uid('it') });
  }
  return { ...c, sections };
}

/**
 * A ground color drawn from the photos themselves: a pale tint of their palette for light, airy
 * sets, a deep one for moody sets — so the plain areas between photos feel part of the story.
 */
export function groundFor(ps: Photo[]) {
  const labs = ps.map((p) => p.analysis?.lab).filter(Boolean) as [number, number, number][];
  const L = labs.reduce((s, l) => s + l[0], 0) / Math.max(1, labs.length);
  let r = 0, g = 0, b = 0, n = 0;
  for (const p of ps)
    for (const hex of p.analysis?.palette.slice(0, 2) ?? []) {
      r += parseInt(hex.slice(1, 3), 16); g += parseInt(hex.slice(3, 5), 16); b += parseInt(hex.slice(5, 7), 16); n++;
    }
  if (!n) return '#0d0d0d';
  const [tr, tg, tb] = [r / n, g / n, b / n];
  const light = L > 48;
  const mix = (v: number) => Math.round(light ? 255 - (255 - v) * 0.12 : 11 + (v - 11) * 0.1);
  return '#' + [mix(tr), mix(tg), mix(tb)].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

/**
 * No slivers: a photo that crosses a cut by only a thin strip looks like a mistake on the slide
 * that gets the strip. Nudge it to either straddle properly or clear the cut, whichever is the
 * smaller move. Backdrops (full height) are left alone.
 */
export function fixSlivers(c: Carousel): Carousel {
  let start = 0;
  const sections = c.sections.map((sec) => {
    const origin = start * W;
    start += sec.span;
    const items = sec.items.map((it) => {
      if (it.h >= H - 2) return it;
      let x = origin + it.x;
      for (let seam = W; seam < 40 * W; seam += W) {
        if (!(x < seam && x + it.w > seam)) continue;
        const left = seam - x, right = x + it.w - seam;
        const need = Math.max(150, 0.22 * it.w);
        if (Math.min(left, right) >= need) continue;
        // Either push the small side out to a proper share, or pull it back clear with a margin.
        const toStraddle = need - Math.min(left, right);
        const toClear = Math.min(left, right) + 60;
        const dir = left < right ? 1 : -1; // move toward the side that already has most of it
        x += toStraddle <= toClear ? -dir * toStraddle : dir * toClear;
      }
      return x === origin + it.x ? it : { ...it, x: Math.round(x - origin) };
    });
    return { ...sec, items };
  });
  return { ...c, sections };
}
