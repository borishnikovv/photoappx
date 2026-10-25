import type { Carousel, Crop, Item, Orientation, Photo, StyleOptions } from '../types';

export const SLIDE_W = 1080;
export const SLIDE_H = 1350;

export function orientationOf(w: number, h: number): Orientation {
  const a = w / h;
  if (a < 0.9) return 'portrait';
  if (a <= 1.15) return 'square';
  if (a < 2) return 'landscape';
  return 'pano';
}

export const photoOrientation = (p: Photo) => orientationOf(p.width, p.height);

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The part of the photo visible in an item, normalized 0..1 in photo space.
 * Shared by the DOM preview and the canvas exporter so they always agree.
 */
export function sourceRect(photo: { width: number; height: number }, item: { w: number; h: number; crop: Crop }) {
  const pa = photo.width / photo.height;
  const ia = item.w / item.h;
  // Cover: the visible window spans the photo's full height or width.
  let sw = pa > ia ? ia / pa : 1;
  let sh = pa > ia ? 1 : pa / ia;
  sw /= item.crop.zoom;
  sh /= item.crop.zoom;
  const sx = clamp(item.crop.fx - sw / 2, 0, 1 - sw);
  const sy = clamp(item.crop.fy - sh / 2, 0, 1 - sh);
  return { sx, sy, sw, sh };
}

/** Largest box with the given aspect that fits within maxW x maxH. */
export function fitBox(aspect: number, maxW: number, maxH: number) {
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

export function slideCount(c: Carousel) {
  return c.sections.reduce((n, s) => n + s.span, 0);
}

/** Items with absolute canvas coordinates, sorted bottom to top. */
export function absoluteItems(c: Carousel) {
  const out: (Item & { ax: number; sectionId: string })[] = [];
  let start = 0;
  c.sections.forEach((s, si) => {
    for (const it of s.items) out.push({ ...it, ax: start * SLIDE_W + it.x, sectionId: s.id, z: it.z + si * 0.001 });
    start += s.span;
  });
  return out.sort((a, b) => a.z - b.z);
}

let counter = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

/** Small deterministic RNG so layout variants are reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** The carousel's actual background color. */
export const backgroundOf = (style: StyleOptions, c?: Carousel) => (style.bg === 'auto' ? c?.ground ?? '#0d0d0d' : style.bg);
