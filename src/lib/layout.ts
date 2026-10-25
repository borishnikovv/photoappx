import type { Carousel, Family, Item, Orientation, Photo, Section, StyleOptions } from '../types';
import { closeness, distance } from './curate';
import { layoutBias } from './taste';
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
  /** Geometry is the point (rows, steps, pairs): don't nudge pieces individually. */
  rigid?: boolean;
  /** A signature pattern: every carousel that can fit one should show it at least once. */
  signature?: boolean;
  /** The backdrop is a ground behind prints, not a picture to see whole. */
  ground?: boolean;
  build: Build;
}

const ANY: Orientation[] = ['portrait', 'square', 'landscape', 'pano'];
const TALL: Orientation[] = ['portrait', 'square'];
const WIDE: Orientation[] = ['landscape', 'pano'];
const SQ_WIDE: Orientation[] = ['square', 'landscape', 'pano'];

/**
 * The shape a photo is laid out at. Very tall phone shots (9:16) are trimmed toward 2:3 so they
 * don't run so long; everything else keeps its own shape.
 */
const aspect = (p: Photo) => Math.max(p.width / p.height, 2 / 3);
/**
 * Two landscape/square prints stacked in one aligned column, centered on slide `slide`: the same
 * width, an even gap, the pair centered top to bottom, each with a thin print border.
 */
function column(b: Photo, c: Photo, slide: number, r: () => number, o: StyleOptions): Spec[] {
  // Prints read best landscape: squares get a gentle 5:4 crop, landscapes 4:3 or 3:2.
  const printAspect = (p: Photo) => {
    const a = p.width / p.height;
    if (a < 1.15) return 5 / 4;
    return [4 / 3, 3 / 2].filter((x) => Math.abs(Math.log(x / a)) < 0.25)[Math.floor(r() * 2)] ?? Math.min(a, 16 / 9);
  };
  const ab = printAspect(b), ac = printAspect(c);
  const gap = 44, margin = 64, border = 10;
  const maxH = (H - 2 * margin - gap) / 2 - 2 * border;
  const w = Math.min(W * 0.84, maxH * ab, maxH * ac);
  const hb = w / ab, hc = w / ac;
  const top = (H - (hb + hc + gap + 4 * border)) / 2 + border;
  const x = slide * W + (W - w) / 2;
  const look = { border, shadow: o.overlay === 'framed' };
  return [mk(b, x, top, w, hb, { ...look, z: 1 }), mk(c, x, top + hb + 2 * border + gap, w, hc, { ...look, z: 2 })];
}

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
const FRAMES_TALL = [4 / 5, 3 / 4, 2 / 3];
const FRAMES_WIDE = [4 / 3, 3 / 2, 1, 16 / 9];
export function frameAspect(p: Photo, r: () => number) {
  // Measured against the photo's true shape, so a 9:16 phone shot only ever loses a little height.
  const a = p.width / p.height;
  const opts = (a < 1 ? FRAMES_TALL : FRAMES_WIDE).filter((x) => Math.abs(Math.log(x / a)) < 0.25);
  return opts.length ? pick(r, opts) : aspect(p);
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
      const box = fitBox(frameAspect(b, r), W * (0.55 + r() * 0.1), H * 0.6);
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
      const B = fitBox(frameAspect(b, r), W * 0.56, H * 0.58);
      const C = fitBox(frameAspect(c, r), W * 0.56, H * 0.62);
      const up = r() > 0.5;
      const pb = { x: W - B.w * 0.5, y: up ? 70 : H - B.h - 70 };
      const pc = { x: 2 * W - C.w * 0.5, y: up ? H - C.h - 70 : 70 };
      return [band, mk(b, pb.x, pb.y, B.w, B.h, ov(o)), mk(c, pc.x, pc.y, C.w, C.h, ov(o, 2))];
    },
  },
  // ---- Patterns from editorial carousel apps ----
  {
    id: 'duo-over', label: 'Stacked duo', family: 'layered', span: 1, slots: [ANY, SQ_WIDE, SQ_WIDE], weight: 1.2, rigid: true,
    build: ([a, b, c], r, o) => {
      // Two landscape/square frames on one slide over a backdrop: one high, one low, offset.
      const B = fitBox(frameAspect(b, r), W * 0.76, H * 0.44);
      const C = fitBox(frameAspect(c, r), W * 0.76, H * 0.44);
      const leftFirst = r() > 0.5;
      return [
        mk(a, 0, 0, W, H, { base: true }),
        mk(b, leftFirst ? 70 : W - B.w - 70, 90, B.w, B.h, ov(o)),
        mk(c, leftFirst ? W - C.w - 70 : 70, H - C.h - 90, C.w, C.h, ov(o, 2)),
      ];
    },
  },
  {
    id: 'duo-over2', label: 'Stacked duo ×2', family: 'spread', span: 2, slots: [WIDE, SQ_WIDE, SQ_WIDE], weight: 1.2,
    build: ([a, b, c], r, o) => {
      // The same idea across the cut: one frame high on the first slide, the other low across the cut.
      const bg = mk(a, 0, 0, 2 * W, H, { base: true });
      const B = fitBox(frameAspect(b, r), W * 0.8, H * 0.45);
      const C = fitBox(frameAspect(c, r), W * 0.8, H * 0.45);
      const pb = placeOver(bg, a, B, [90, 160, W - B.w - 90], [90, 140], () => 0);
      const pc = placeOver(bg, a, C, straddle(W, C.w), [H - C.h - 90, H - C.h - 140], () => 0);
      return [bg, mk(b, pb.x, pb.y, B.w, B.h, ov(o)), mk(c, pc.x, pc.y, C.w, C.h, ov(o, 2))];
    },
  },
  {
    id: 'column2', label: 'Print column', family: 'layered', span: 1, slots: [ANY, SQ_WIDE, SQ_WIDE], weight: 1.3, rigid: true, ground: true,
    build: ([a, b, c], r, o) => [mk(a, 0, 0, W, H, { base: true }), ...column(b, c, 0, r, o)],
  },
  {
    id: 'column4', label: 'Print columns ×2', family: 'spread', span: 2, slots: [WIDE, SQ_WIDE, SQ_WIDE, SQ_WIDE, SQ_WIDE], weight: 1.6, rigid: true, signature: true, hero: true, ground: true,
    // One backdrop across both slides, an aligned pair of prints on each: the album-page spread.
    build: ([a, b, c, d, e], r, o) => [mk(a, 0, 0, 2 * W, H, { base: true }), ...column(b, c, 0, r, o), ...column(d, e, 1, r, o)],
  },
  {
    id: 'column4-split', label: 'Print columns on two', family: 'layered', span: 2, slots: [TALL, TALL, SQ_WIDE, SQ_WIDE, SQ_WIDE, SQ_WIDE], weight: 1.1, rigid: true, ground: true,
    // The same with a backdrop per slide, for when no wide photo suits.
    build: ([a, b, c, d, e, f], r, o) => [mk(a, 0, 0, W, H, { base: true }), mk(b, W, 0, W, H, { base: true }), ...column(c, d, 0, r, o), ...column(e, f, 1, r, o)],
  },
  {
    id: 'split-h', label: 'Split', family: 'gallery', span: 1, slots: [WIDE, WIDE], weight: 0.9,
    build: ([a, b]) => [mk(a, 0, 0, W, H / 2, { base: true }), mk(b, 0, H / 2, W, H / 2, { base: true })],
  },
  {
    id: 'triptych', label: 'Triptych', family: 'layered', span: 2, slots: [WIDE, ANY, ANY, ANY], weight: 1, rigid: true,
    build: ([a, ...ps], r, o) => {
      // Three squares in a row over a backdrop, the middle one on the cut.
      const size = Math.round(W * (0.5 + r() * 0.06)), gap = 36;
      const x0 = W - size / 2 - size - gap, y = Math.round((H - size) / 2 + (r() - 0.5) * 120);
      return [mk(a, 0, 0, 2 * W, H, { base: true }), ...ps.map((p, i) => mk(p, x0 + i * (size + gap), y, size, size, ov(o, i + 1)))];
    },
  },
  {
    id: 'diagonal', label: 'Diagonal step', family: 'layered', span: 2, slots: [WIDE, ANY, ANY, ANY], weight: 0.9, rigid: true,
    build: ([a, ...ps], r, o) => {
      // Three frames stepping down across two slides, the middle one on the cut.
      const boxes = ps.map((p) => fitBox(frameAspect(p, r), W * 0.55, H * 0.42));
      const xs = [90, W - boxes[1].w / 2, 2 * W - boxes[2].w - 90];
      const ys = [90, (H - boxes[1].h) / 2, H - boxes[2].h - 90];
      return [mk(a, 0, 0, 2 * W, H, { base: true }), ...ps.map((p, i) => mk(p, xs[i], ys[i], boxes[i].w, boxes[i].h, ov(o, i + 1)))];
    },
  },
  {
    id: 'window', label: 'Window', family: 'gallery', span: 1, slots: [ANY, ANY], weight: 0.8,
    build: ([a, b], r, o) => {
      // One photo centered over a soft, tightly zoomed backdrop, like a print on a wall of color.
      const box = fitBox(frameAspect(b, r), W * 0.74, H * 0.72);
      return [
        { ...mk(a, 0, 0, W, H, { base: true }), crop: { ...focalPoint(a), zoom: 1.6 } },
        mk(b, (W - box.w) / 2, (H - box.h) / 2 - 20, box.w, box.h, ov(o)),
      ];
    },
  },
  {
    id: 'big-detail', label: 'Big + detail', family: 'layered', span: 1, slots: [ANY, ANY, ANY], weight: 0.9, rigid: true,
    build: ([a, b, c], r, o) => {
      // A large frame with a small detail shot overlapping its lower corner.
      const B = fitBox(frameAspect(b, r), W * 0.78, H * 0.62);
      const C = fitBox(frameAspect(c, r), W * 0.46, H * 0.36);
      const left = r() > 0.5;
      const bx = left ? 70 : W - B.w - 70, by = 100;
      const cx = left ? Math.min(W - C.w - 60, bx + B.w - C.w * 0.6) : Math.max(60, bx - C.w * 0.4), cy = Math.min(H - C.h - 80, by + B.h - C.h * 0.45);
      return [mk(a, 0, 0, W, H, { base: true }), mk(b, bx, by, B.w, B.h, ov(o)), mk(c, cx, cy, C.w, C.h, ov(o, 2))];
    },
  },
  {
    id: 'cascade', label: 'Cascade', family: 'spread', span: 2, slots: [TALL, TALL, TALL], weight: 1.1, rigid: true,
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
    id: 'strip3', label: 'Film strip', family: 'gallery', span: 2, slots: [TALL, TALL, TALL], weight: 0.9, rigid: true,
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

// ---- Mosaics: editorial album spreads ----------------------------------------------------------
// Full-height backdrops tiled side by side (their join deliberately off the slide cut), with a
// designed group of frames — equal heights, shared top/bottom lines, even gutters — laid right
// over the join, so it stitches one picture into the next.

type Group = { id: string; label: string; slots: Orientation[][]; cells: (ps: Photo[], r: () => number) => { w: number; h: number; x: number; y: number }[] };
const GAP = 28;
/** Cell layouts relative to the group's center (0, 0). */
const GROUPS: Group[] = [
  {
    id: 'one-tall', label: 'frame', slots: [TALL],
    cells: ([a], r) => { const b = fitBox(Math.min(aspect(a), 0.8), W * 0.62, H * (0.6 + r() * 0.1)); return [{ ...b, x: -b.w / 2, y: -b.h / 2 - H * 0.03 }]; },
  },
  {
    id: 'one-wide', label: 'wide frame', slots: [SQ_WIDE],
    cells: ([a], r) => { const b = fitBox(frameAspect(a, r), W * 0.95, H * 0.56); return [{ ...b, x: -b.w / 2, y: -b.h / 2 - H * 0.04 }]; },
  },
  {
    id: 'stack', label: 'stacked pair', slots: [SQ_WIDE, SQ_WIDE],
    cells: ([a, b], r) => {
      // One high, one low, slightly offset and overlapping — like prints laid on a table.
      const A = fitBox(frameAspect(a, r), W * 0.8, H * 0.44), B = fitBox(frameAspect(b, r), W * 0.8, H * 0.44);
      const off = W * 0.04 * (r() > 0.5 ? 1 : -1);
      return [{ ...A, x: -A.w / 2 - off, y: -H / 2 + 100 }, { ...B, x: -B.w / 2 + off, y: H / 2 - 100 - B.h }];
    },
  },
  {
    id: 'row-tall', label: 'pair', slots: [TALL, TALL],
    cells: (_, r) => {
      // Two tall frames, exactly the same height and top line, an even gutter between.
      const h = H * (0.6 + r() * 0.08), w = h * (2 / 3);
      return [{ w, h, x: -w - GAP / 2, y: -h / 2 }, { w, h, x: GAP / 2, y: -h / 2 }];
    },
  },
  {
    id: 'row-mixed', label: 'portrait + landscape', slots: [TALL, WIDE],
    cells: () => {
      // Equal heights: a portrait beside a landscape, sharing top and bottom lines.
      const h = H * 0.5, pw = h * (2 / 3), lw = h * 1.5;
      const total = pw + GAP + lw;
      return [{ w: pw, h, x: -total / 2, y: -h / 2 }, { w: lw, h, x: -total / 2 + pw + GAP, y: -h / 2 }];
    },
  },
  {
    id: 'grid', label: '2×2 grid', slots: [SQ_WIDE, SQ_WIDE, SQ_WIDE, SQ_WIDE],
    cells: (_, r) => {
      const w = W * (0.6 + r() * 0.05), h = w / 1.5;
      return [0, 1, 2, 3].map((i) => ({ w, h, x: (i % 2 ? GAP / 2 : -w - GAP / 2), y: i < 2 ? -h - GAP / 2 : GAP / 2 }));
    },
  },
];

/** Shifts a group sideways (as little as possible) so none of its frames crosses a cut by a sliver. */
function settleGroup(cells: { w: number; h: number; x: number; y: number }[], span: number) {
  const sliverCost = (dx: number) =>
    cells.reduce((c, b) => {
      let t = 0;
      for (let s2 = W; s2 < span * W; s2 += W) {
        const l = s2 - (b.x + dx), rr = b.x + dx + b.w - s2;
        if (l > 0 && rr > 0 && Math.min(l, rr) < Math.max(150, 0.22 * b.w)) t += Math.max(150, 0.22 * b.w) - Math.min(l, rr);
      }
      const out = Math.max(0, 40 - (b.x + dx)) + Math.max(0, b.x + dx + b.w - (span * W - 40));
      return c + t + out * 3;
    }, 0) + Math.abs(dx) * 0.2;
  let best = 0, bestC = sliverCost(0);
  for (let dx = -0.4 * W; dx <= 0.4 * W; dx += 10) {
    const c = sliverCost(dx);
    if (c < bestC) [best, bestC] = [dx, c];
  }
  return cells.map((b) => ({ ...b, x: b.x + best }));
}

function makeMosaics(): Template[] {
  const out: Template[] = [];
  // Where the two backdrops meet, in slides. Never right on a cut: the frames hide the join instead.
  const joins: Record<number, number[]> = { 2: [0.8, 1.25], 3: [1.35, 1.7] };
  for (const span of [2, 3])
    for (const join of joins[span])
      for (const g of GROUPS) {
        if (span === 3 && (g.id === 'one-tall' || g.id === 'one-wide')) continue; // too little for 3 slides
        out.push({
          id: `mosaic${span}-${g.id}-${Math.round(join * 100)}`,
          label: `Mosaic · ${g.label}`,
          family: 'mosaic',
          span,
          slots: [ANY, ANY, ...g.slots],
          weight: g.id === 'grid' ? 0.8 : 1.1,
          hero: span === 3,
          rigid: true,
          build: ([a, b, ...ps], r, o) => {
            const jx = Math.round(join * W);
            const center = { x: jx, y: H / 2 };
            const cells = settleGroup(
              g.cells(ps, r).map((c) => ({ ...c, x: c.x + center.x, y: c.y + center.y })),
              span,
            );
            return [
              mk(a, 0, 0, jx, H, { base: true }),
              mk(b, jx, 0, span * W - jx, H, { base: true }),
              ...ps.map((p, i) => mk(p, cells[i].x, cells[i].y, cells[i].w, cells[i].h, ov(o, i + 1))),
            ];
          },
        });
      }
  return out;
}
TEMPLATES.push(...makeMosaics());

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id)!;

const labDist = (a: Photo, b: Photo) => {
  const x = a.analysis?.lab, y = b.analysis?.lab;
  return x && y ? Math.hypot((x[0] - y[0]) * 0.5, x[1] - y[1], x[2] - y[2]) : 50;
};

/** Assign photos to a template's slots. The first candidate must be used, to keep the sequence. */
function assign(t: Template, cands: Photo[]): Photo[] | null {
  // Spreads: photos laid on a backdrop should belong to it, so try the closest colors first.
  if (t.family === 'spread' && cands.length > 2) cands = [cands[0], ...cands.slice(1).sort((a, b) => labDist(a, cands[0]) - labDist(b, cands[0]))];
  // Never two near-identical photos on the same layout (a backdrop with its look-alike on top).
  const a0 = cands[0].analysis;
  if (a0?.grid) cands = [cands[0], ...cands.slice(1).filter((c) => !c.analysis?.grid || distance(a0, c.analysis) > 0.3)];
  const used = new Set<number>();
  const out: Photo[] = [];
  const rec = (slot: number): boolean => {
    if (slot === t.slots.length) return used.has(0);
    for (let i = 0; i < cands.length; i++) {
      if (used.has(i) || !t.slots[slot].includes(photoOrientation(cands[i]))) continue;
      // …and no look-alike pairs anywhere in the layout.
      const ai = cands[i].analysis;
      if (ai?.grid && out.some((q) => q.analysis?.grid && distance(ai, q.analysis) <= 0.3)) continue;
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
  return finishSection(sec, new Map(ps.map((p) => [p.id, p])));
}

/** Coverage, art-directed crops, overlays off subjects, subjects off cuts — in that order. */
export function finishSection(sec: Section, byId: Map<string, Photo>): Section {
  const ps = sec.items.map((i) => byId.get(i.photoId)!).filter(Boolean);
  sec.items = coverSection(sec.items, byId, sec.span);
  // Print columns are sized as a set (same width, even gaps); growing one would break the column.
  if (!templateById(sec.template)?.ground) for (const it of sec.items) if (!it.base) growToReadable(it, sec.span);
  for (const it of sec.items) artCrop(it, byId.get(it.photoId)!, sec.span);
  if (!templateById(sec.template)?.rigid) settleOverlays(sec.items, byId);
  keepFacesOffSeams(sec, ps);
  return sec;
}

/**
 * Photos on top must be big enough to read on a phone: at least about half a slide wide or tall.
 * Small ones grow around their center (keeping their shape) and stay inside the canvas.
 */
function growToReadable(it: Spec, span: number) {
  const minW = W * 0.5, minH = H * 0.5, maxW = W * 0.88, maxH = H * 0.86;
  let k = Math.max(1, Math.min(minW / it.w, minH / it.h));
  k = Math.min(k, maxW / it.w, maxH / it.h);
  if (k <= 1.01) return;
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  it.w = Math.round(it.w * k);
  it.h = Math.round(it.h * k);
  it.x = Math.round(Math.max(30, Math.min(span * W - it.w - 30, cx - it.w / 2)));
  it.y = Math.round(Math.max(30, Math.min(H - it.h - 30, cy - it.h / 2)));
}

/** Whether a set of rectangles together leaves no gap anywhere in the section. */
function tilesCover(tiles: Spec[], span: number) {
  for (let x = 10; x < span * W; x += 40)
    for (let y = 10; y < H; y += 40)
      if (!tiles.some((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h)) return false;
  return true;
}

const fullyCovers = (it: Spec, span: number) => it.x <= 0 && it.y <= 0 && it.x + it.w >= span * W && it.y + it.h >= H;

/**
 * Photos always cover the whole canvas: every slide gets a backdrop filling it edge to edge.
 * One photo spans the whole section if its shape allows a reasonable crop; otherwise each slide
 * gets its own backdrop (a portrait per slide), and everything else is laid on top.
 */
function coverSection<T extends Spec>(items: T[], byId: Map<string, Photo>, span: number): T[] {
  const bridges = items.filter((i) => i.bridge);
  const layout = items.filter((i) => !i.bridge);
  const asBase = (it: T, x: number, w: number): T => ({ ...it, x, y: 0, w, h: H, border: 0, shadow: false, z: 0, base: true });
  const overlay = (it: T): T => ({ ...it, base: false, z: Math.max(1, it.z) });
  // A layout may tile its own backdrop (e.g. two landscapes stacked): keep it if the tiles fill it.
  const declared = layout.filter((it) => it.base);
  if (declared.length > 1 && tilesCover(declared, span))
    return [...layout.map((it) => (it.base ? { ...it, border: 0, shadow: false, z: 0 } : overlay(it))), ...bridges];
  const whole = layout.find((it) => fullyCovers(it, span));
  if (whole) return [...layout.map((it) => (it === whole ? asBase(it, 0, span * W) : overlay(it))), ...bridges];
  if (!layout.length) return items;

  // How much a photo must be cropped to fill a region of this shape (1 = perfect fit).
  const crop = (it: T, shape: number) => {
    const p = byId.get(it.photoId)!;
    const a = p.width / p.height;
    return Math.max(a / shape, shape / a);
  };
  const byArea = [...layout].sort((a, b) => b.w * b.h - a.w * a.h);
  const single = [...layout].sort((a, b) => crop(a, (span * W) / H) - crop(b, (span * W) / H))[0];
  const tiles = span > 1 && crop(single, (span * W) / H) > 1.9 && layout.length >= 2;
  if (!tiles) {
    // Prefer the photo that fills the section with the least cropping, then the biggest one.
    const base = crop(single, (span * W) / H) <= 1.9 ? single : byArea[0];
    return [...layout.map((it) => (it === base ? asBase(it, 0, span * W) : overlay(it))), ...bridges];
  }
  // One backdrop per slide (portrait-friendly); if photos run out, the last one widens to cover.
  const order = [...layout].sort((a, b) => crop(a, W / H) - crop(b, W / H));
  const bases = order.slice(0, Math.min(span, layout.length - 1 >= 1 ? Math.min(span, layout.length - 1) : 1));
  const out: T[] = [];
  bases.forEach((it, k) => {
    const last = k === bases.length - 1;
    out.push(asBase(it, k * W, last ? (span - k) * W : W));
  });
  for (const it of layout) if (!bases.includes(it)) out.push(overlay(it));
  return [...out, ...bridges];
}

/**
 * Art-directed crop: put the subject (faces, else the most detailed region) on a rule-of-thirds
 * line of the slide it sits on, keep it whole, and zoom in a touch on small subjects — but only
 * as far as the photo's resolution stays sharp.
 */
function artCrop(it: Spec, p: Photo, span: number) {
  if (!p) return;
  const subj = protectedBoxes(p);
  if (!subj.length) return;
  const sx0 = Math.min(...subj.map((b) => b.x)), sx1 = Math.max(...subj.map((b) => b.x + b.w));
  const sy0 = Math.min(...subj.map((b) => b.y)), sy1 = Math.max(...subj.map((b) => b.y + b.h));
  const scx = (sx0 + sx1) / 2, scy = (sy0 + sy1) / 2;
  // Thirds of every slide the item covers, in the item's own pixels.
  const tx: number[] = [];
  for (let k = 0; k < span; k++) for (const f of [1 / 3, 1 / 2, 2 / 3]) {
    const x = k * W + f * W - it.x;
    if (x > 0 && x < it.w) tx.push(x);
  }
  if (!tx.length) tx.push(it.w / 3, it.w / 2, (2 * it.w) / 3);
  const ty = [it.h / 3, it.h * 0.42, (2 * it.h) / 3];
  const maxZoom = Math.min(1.5, Math.max(1, (p.width * Math.min(1, sourceRect(p, { ...it, crop: { ...it.crop, zoom: 1 } }).sw)) / (it.w * 0.9)));
  let best = it.crop, bestC = Infinity;
  for (const zoom of [1, 1.1, 1.2, 1.32, 1.45].filter((z) => z <= maxZoom))
    for (let fx = 0; fx <= 1.0001; fx += 0.05)
      for (let fy = 0; fy <= 1.0001; fy += 0.05) {
        const { sx, sy, sw, sh } = sourceRect(p, { ...it, crop: { fx, fy, zoom } });
        // Subject must stay whole (a little trimming is tolerated); heavily penalize cutting it.
        const cut = Math.max(0, sx - sx0) + Math.max(0, sx1 - (sx + sw)) + Math.max(0, sy - sy0) + Math.max(0, sy1 - (sy + sh));
        const px = ((scx - sx) / sw) * it.w, py = ((scy - sy) / sh) * it.h;
        const dx = Math.min(...tx.map((t) => Math.abs(px - t))) / it.w;
        const dy = Math.min(...ty.map((t) => Math.abs(py - t))) / it.h;
        const subjArea = ((sx1 - sx0) * (sy1 - sy0)) / (sw * sh);
        // Zoom only pays off when the subject is small in the frame.
        // Zooming in pays off when the subject is small in the frame; big subjects stay as they are.
        const zoomCost = zoom > 1 ? (subjArea > 0.2 ? 0.5 : subjArea > 0.1 ? 0.12 : -0.04) * (zoom - 1) * 4 : 0;
        const c = cut * 8 + dx + dy * 0.6 + zoomCost + Math.abs(fx - it.crop.fx) * 0.05 + Math.abs(fy - it.crop.fy) * 0.05;
        if (c < bestC) [best, bestC] = [{ fx, fy, zoom }, c];
      }
  it.crop = best;
}

/** Nudges photos laid on top off whatever they'd hide underneath (faces, the subject). */
function settleOverlays(items: Spec[], byId: Map<string, Photo>) {
  const bases = items.filter((i) => i.base);
  for (const it of items) {
    if (it.base || it.bridge) continue;
    const cost = (x: number, y: number) =>
      bases.reduce((c, b) => c + coverCost({ x0: x, x1: x + it.w, y0: y, y1: y + it.h }, b, byId.get(b.photoId)!), 0) +
      (Math.abs(x - it.x) + Math.abs(y - it.y)) * 30;
    let best = { x: it.x, y: it.y }, bestC = cost(it.x, it.y);
    for (const dx of [-0.2, -0.1, 0, 0.1, 0.2].map((f) => f * W))
      for (const dy of [-0.15, -0.08, 0, 0.08, 0.15].map((f) => f * H)) {
        const x = it.x + dx, y = Math.max(40, Math.min(H - it.h - 40, it.y + dy));
        const c = cost(x, y);
        if (c < bestC) [best, bestC] = [{ x, y }, c];
      }
    it.x = Math.round(best.x);
    it.y = Math.round(best.y);
  }
}

/**
 * What must not be sliced by a cut: faces if there are any, otherwise the photo's subject, taken
 * as the compact cluster of its most detailed cells (the cup, the cat, the motorcycle).
 */
function protectedBoxes(p: Photo): { x: number; y: number; w: number; h: number; wt: number }[] {
  const faces = p.analysis?.faces;
  if (faces?.length) return faces.map((f) => ({ ...f, wt: 1 }));
  const d = p.analysis?.detail;
  // No clear subject (detail everywhere, or nowhere): photographers center what matters, so
  // protect the middle of the frame.
  const middle = [{ x: 0.32, y: 0.25, w: 0.36, h: 0.5, wt: 0.5 }];
  if (!d) return middle;
  const max = Math.max(...d);
  if (max < 0.15) return middle;
  let x0 = 8, x1 = 0, y0 = 8, y1 = 0, n = 0;
  d.forEach((v, i) => {
    if (v < 0.75 * max) return;
    const cx = i % 8, cy = (i / 8) | 0;
    x0 = Math.min(x0, cx); x1 = Math.max(x1, cx + 1); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy + 1); n++;
  });
  // Detail spread all over (texture, crowds) isn't a single subject.
  if ((x1 - x0) * (y1 - y0) > 30 || !n) return middle;
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
  { name: 'Editorial', boost: { mosaic: 3, spread: 1, layered: 0.7, gallery: 0.4, pano: 0.6 } },
  { name: 'Spread', boost: { spread: 2.6, mosaic: 1.2, layered: 0.9, gallery: 0.5 } },
  { name: 'Cinematic', boost: { pano: 2.2, spread: 1.4, mosaic: 1, layered: 1.2, gallery: 0.5 } },
];

/**
 * How good a laid-out section looks, roughly 0 (poor) … 1 (excellent). An art director's checklist:
 * nothing important hidden, everything readable, photos cropped kindly and kept sharp, weight
 * balanced on each slide, breathing room at the outer edges, frames that line up, clean crossings
 * of the cuts, colors that belong together.
 */
export function scoreSection(sec: Section, byId: Map<string, Photo>) {
  const items = sec.items.filter((i) => !i.bridge);
  const bases = items.filter((i) => i.base), ovs = items.filter((i) => !i.base);
  const notes: Record<string, number> = {};
  // Hidden subjects and faces (cost per unit of overlay area).
  let hidden = 0;
  for (const o of ovs)
    for (const b of bases) hidden += coverCost({ x0: o.x, x1: o.x + o.w, y0: o.y, y1: o.y + o.h }, b, byId.get(b.photoId)!) / (o.w * o.h);
  notes.hidden = Math.min(1, hidden / Math.max(1, ovs.length) / 0.9);
  // Print columns use the backdrop as a ground (a texture behind the prints): covering its
  // busier parts costs less there, while faces still count in full.
  if (templateById(sec.template)?.ground && notes.hidden < 0.9) notes.hidden *= 0.4;
  // Overlays covering each other too much.
  let lap = 0;
  for (let i = 0; i < ovs.length; i++)
    for (let j = i + 1; j < ovs.length; j++) {
      const A = ovs[i], B = ovs[j];
      const o = area({ x0: A.x, x1: A.x + A.w, y0: A.y, y1: A.y + A.h }, { x0: B.x, x1: B.x + B.w, y0: B.y, y1: B.y + B.h });
      lap += Math.max(0, o / Math.min(A.w * A.h, B.w * B.h) - 0.25);
    }
  notes.overlap = Math.min(1, lap);
  // Crops: too little of the photo left, or blown up past its resolution.
  let crop = 0;
  for (const it of items) {
    const p = byId.get(it.photoId)!;
    const { sw, sh } = sourceRect(p, it);
    crop += Math.max(0, 0.4 - sw * sh) * 2 + Math.max(0, it.w / (sw * p.width) - 1.15) * 0.8;
  }
  notes.crop = Math.min(1, crop / items.length);
  // Readability: frames under half a slide are hard to see on a phone.
  notes.small = Math.min(1, ovs.reduce((t, o) => t + Math.max(0, 0.5 - Math.max(o.w / W, o.h / H)) * 3, 0));
  // Balance: on each slide, the frames' visual weight shouldn't all sit on one side.
  let tilt = 0;
  for (let k = 0; k < sec.span; k++) {
    let m = 0, mx = 0;
    for (const o of ovs) {
      const x0 = Math.max(o.x, k * W), x1 = Math.min(o.x + o.w, (k + 1) * W);
      if (x1 <= x0) continue;
      const a2 = (x1 - x0) * o.h;
      m += a2;
      mx += a2 * ((x0 + x1) / 2 - k * W);
    }
    if (m) tilt += Math.abs(mx / m - W / 2) / W;
  }
  notes.balance = Math.min(1, tilt / sec.span) * 0.8;
  // Breathing room: frames shouldn't crowd the carousel's top/bottom or a slide's outer edge.
  notes.margin = Math.min(1, ovs.reduce((t, o) => t + (o.y < 40 ? 0.3 : 0) + (o.y + o.h > H - 40 ? 0.3 : 0) + (o.x < 30 && o.x > -o.w ? 0.2 : 0), 0));
  // Rhythm: frames that share an edge or center line read as designed.
  let aligned = 0;
  for (let i = 0; i < ovs.length; i++)
    for (let j = i + 1; j < ovs.length; j++) {
      const A = ovs[i], B = ovs[j];
      const xs = [A.x, A.x + A.w / 2, A.x + A.w], xs2 = [B.x, B.x + B.w / 2, B.x + B.w];
      const ys = [A.y, A.y + A.h / 2, A.y + A.h], ys2 = [B.y, B.y + B.h / 2, B.y + B.h];
      if (xs.some((x) => xs2.some((x2) => Math.abs(x - x2) < 14)) || ys.some((y) => ys2.some((y2) => Math.abs(y - y2) < 14))) aligned++;
    }
  notes.aligned = -Math.min(0.3, aligned * 0.15);
  // Cuts: crossing one is good (continuity) but never by a sliver.
  let seams = 0;
  for (const o of ovs)
    for (let sx = W; sx < sec.span * W; sx += W)
      if (o.x < sx && o.x + o.w > sx) seams += Math.min(sx - o.x, o.x + o.w - sx) >= 0.22 * o.w ? -0.15 : 0.4;
  notes.seams = Math.max(-0.3, Math.min(1, seams));
  // Color: frames should belong to their backdrop.
  let color = 0;
  for (const o of ovs) color += bases.length ? Math.min(...bases.map((b) => labDist(byId.get(o.photoId)!, byId.get(b.photoId)!))) / 120 : 0;
  notes.color = Math.min(1, color / Math.max(1, ovs.length));
  // Sliced subjects: a face or the main subject cut in two by a slide edge is the worst look.
  let sliced = 0;
  for (const it of items) {
    const p = byId.get(it.photoId)!;
    const { sx, sy, sw, sh } = sourceRect(p, it);
    for (const b of protectedBoxes(p)) {
      const l = it.x + ((b.x - sx) / sw) * it.w, rr = it.x + ((b.x + b.w - sx) / sw) * it.w;
      const t = it.y + ((b.y - sy) / sh) * it.h, bt = it.y + ((b.y + b.h - sy) / sh) * it.h;
      if (bt < 0 || t > H) continue;
      for (let cut = W; cut < sec.span * W; cut += W)
        if (l < cut && rr > cut) {
          const minor = Math.min(cut - l, rr - cut) / Math.max(1, rr - l);
          if (minor > 0.08) sliced += b.wt * Math.min(1, minor * 2.5);
        }
    }
  }
  notes.sliced = Math.min(1.5, sliced);
  // Stitches: where two backdrops meet mid-slide, frames laid over the join read as designed;
  // a bare join reads as a mistake.
  const sortedBases = [...bases].sort((a, b) => a.x - b.x);
  let stitch = 0;
  for (let i = 1; i < sortedBases.length; i++) {
    const bx = sortedBases[i].x;
    if (sortedBases[i].y > 0 || Math.abs(bx % W) < 1) continue; // stacked tiles, or a join on a cut
    stitch += ovs.some((o) => o.x < bx - 40 && o.x + o.w > bx + 40) ? -0.25 : 0.5;
  }
  notes.stitch = stitch;
  // Scale contrast: details and close-ups make the best backdrops behind wider scenes.
  if (bases.length && ovs.length) {
    const avg = (xs: Spec[]) => xs.reduce((t, it) => t + closeness(byId.get(it.photoId)!), 0) / xs.length;
    const diff = avg(bases) - avg(ovs);
    notes.scale = diff > 0 ? -Math.min(0.3, diff) : Math.min(0.4, -diff);
  }
  const W8: Record<string, number> = { hidden: 3, overlap: 1.5, crop: 2, small: 1.5, balance: 1, margin: 0.8, aligned: 1, seams: 1, color: 0.8, stitch: 1.2, scale: 1, sliced: 5 };
  const penalty = Object.entries(notes).reduce((t, [k, v]) => t + W8[k] * v, 0);
  return { score: Math.max(0, 1 - penalty / 6), notes };
}

/**
 * Lays the photos out section by section. At each step every layout that fits the next photos is
 * actually built (with a couple of variations) and scored by `scoreSection`; the best wins, with
 * a nudge for the chosen style, for variety (no repeats back to back), for strong openers, and
 * for using photos at the pace needed to fill the carousel.
 */
export function generateCarousel(photos: Photo[], o: StyleOptions, seed: number, emph: Emphasis): Carousel {
  const r = rng(seed);
  const queue = [...photos];
  const sections: Section[] = [];
  const byId = new Map(photos.map((p) => [p.id, p]));
  let slides = 0;
  const recent: string[] = [];
  const recentFamilies: string[] = [];
  const allowed = TEMPLATES.filter((t) => t.family === 'base' || o.families[t.family]);

  while (queue.length && slides < o.maxSlides) {
    const left = o.maxSlides - slides;
    // Photos per slide we need from here on to fit everything in.
    const density = queue.length / left;
    let best: { sec: Section; t: Template; ps: Photo[]; v: number } | null = null;
    for (const t of allowed) {
      if (t.span > left) continue;
      const ps = assign(t, queue.slice(0, t.slots.length >= 5 ? 9 : t.family === 'spread' ? 7 : 6));
      if (!ps) continue;
      let w = t.weight * (emph.boost[t.family] ?? 1) * layoutBias(t.id, t.family);
      if (recent[0] === t.id) w *= 0.1;
      else if (recent.includes(t.id)) w *= 0.5;
      // Keep the rhythm varied: a third section in a row from the same family has to earn it.
      if (recentFamilies[0] === t.family && recentFamilies[1] === t.family) w *= 0.55;
      if (sections.length === 0) w *= t.hero ? 1.6 : 0.6;
      // Signature patterns: strongly wanted once, welcome a second time in a long carousel.
      if (t.signature) {
        const seen = sections.filter((x) => x.template === t.id).length;
        if (!seen) w *= 8;
        else if (seen === 1 && !recent.slice(0, 3).includes(t.id) && left > 6) w *= 2;
      }
      // Pace: use photos at the rate that fills the carousel exactly — not faster, not slower.
      const perSlide = ps.length / t.span;
      w *= Math.exp(-1.4 * Math.abs(perSlide - density));
      for (let k = 0; k < (t.family === 'mosaic' ? 1 : 2); k++) {
        const sec = buildSection(t, ps, rng(Math.floor(r() * 1e9)), o);
        const v = scoreSection(sec, byId).score * 3 + Math.log(w) * 0.6 + r() * 0.25;
        if (!best || v > best.v) best = { sec, t, ps, v };
      }
    }
    if (!best) {
      // Nothing fits this photo with the chosen styles: a full-bleed slide.
      const t = templateById('full');
      best = { sec: buildSection(t, [queue[0]], r, o), t, ps: [queue[0]], v: 0 };
    }
    sections.push(best.sec);
    for (const p of best.ps) queue.splice(queue.indexOf(p), 1);
    slides += best.t.span;
    recent.unshift(best.t.id);
    recent.length = Math.min(recent.length, 3);
    recentFamilies.unshift(best.t.family);
    recentFamilies.length = Math.min(recentFamilies.length, 2);
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

/** After removing a photo: make sure the section is still covered edge to edge. */
export function recoverSection(sec: Section, byId: Map<string, Photo>): Section {
  const items = coverSection(sec.items, byId, sec.span);
  return { ...sec, items };
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
    const onSlide = (j: number) => abs().filter((it) => !it.base && it.x < (j + 1) * W - 20 && it.x + it.w > j * W + 20).length;
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
