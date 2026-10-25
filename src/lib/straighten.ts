import type { FaceBox, Photo } from '../types';
import { measure } from './curate';

const MAX_EDGE = 4096;

/** Scale of the largest same-aspect rectangle that fits inside a w×h image rotated by `rad`. */
export function innerScale(w: number, h: number, rad: number) {
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  return Math.min(w / (w * c + h * s), h / (w * s + h * c));
}

/** Where a normalized point lands after rotating by `rad` about the center and cropping by `scale`. */
function mapPoint(u: number, v: number, w: number, h: number, rad: number, scale: number) {
  const dx = (u - 0.5) * w, dy = (v - 0.5) * h;
  const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
  return [rx / (w * scale) + 0.5, ry / (h * scale) + 0.5];
}

async function encode(canvas: OffscreenCanvas, edge: number) {
  const s = Math.min(1, edge / Math.max(canvas.width, canvas.height));
  if (s === 1) return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const small = new OffscreenCanvas(Math.round(canvas.width * s), Math.round(canvas.height * s));
  const ctx = small.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  return small.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

/**
 * Levels and un-skews an image: rotate by the tilt, then undo keystone (verticals leaning in a fan
 * from looking up or down) row by row, and crop to the largest clean rectangle — no empty corners.
 * Returns the canvas and where a normalized point of the source lands in it.
 */
export async function renderLevel(src: Blob, tiltDeg: number, keystone: number, maxEdge = MAX_EDGE) {
  const rad = (-tiltDeg * Math.PI) / 180;
  const bmp = await createImageBitmap(src);
  const fit = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * fit), h = Math.round(bmp.height * fit);
  const scale = innerScale(w, h, rad);
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  const rot = new OffscreenCanvas(cw, ch);
  const rc = rot.getContext('2d')!;
  rc.imageSmoothingQuality = 'high';
  rc.translate(cw / 2, ch / 2);
  rc.rotate(rad);
  rc.drawImage(bmp, -w / 2, -h / 2, w, h);
  bmp.close();
  // Keystone: a vertical edge at horizontal position x0 (from center) runs x(y) = x0·f(y), with
  // f(y) = 1 + g·(y − center). Sampling each row f(y) wide straightens them all.
  const g = -Math.tan((keystone * Math.PI) / 180) / (cw / 2);
  const f = (y: number) => 1 + g * (y - ch / 2);
  const fmax = Math.max(f(0), f(ch), 1);
  if (Math.abs(keystone) < 0.05) {
    const map = (u: number, v: number) => mapPoint(u, v, w, h, rad, scale);
    return { canvas: rot, map, cropScale: scale };
  }
  const ow = Math.round(cw / fmax);
  const out = new OffscreenCanvas(ow, ch);
  const oc = out.getContext('2d')!;
  oc.imageSmoothingQuality = 'high';
  for (let y = 0; y < ch; y++) {
    const sw = ow * f(y + 0.5);
    oc.drawImage(rot, cw / 2 - sw / 2, y, sw, 1, 0, y, ow, 1);
  }
  const map = (u: number, v: number) => {
    const [ru, rv] = mapPoint(u, v, w, h, rad, scale);
    const y = rv * ch;
    return [(ru * cw - cw / 2) / f(y) / ow + 0.5, rv];
  };
  return { canvas: out, map, cropScale: scale / fmax };
}

/** Returns the fields to merge into the photo: a leveled, un-skewed copy, keeping the original. */
export async function straighten(p: Photo, tiltDeg: number, keystone = 0): Promise<Partial<Photo>> {
  const base = p.original ?? { file: p.file, width: p.width, height: p.height, thumb: p.thumb, faces: p.analysis?.faces };
  const { canvas, map, cropScale } = await renderLevel(base.file, tiltDeg, keystone);
  const [file, thumb] = await Promise.all([encode(canvas, MAX_EDGE), encode(canvas, 640)]);
  const faces: FaceBox[] | undefined = base.faces?.map((fc) => {
    const [cx, cy] = map(fc.x + fc.w / 2, fc.y + fc.h / 2);
    const fw = fc.w / cropScale, fh = fc.h / cropScale;
    return { ...fc, x: cx - fw / 2, y: cy - fh / 2, w: fw, h: fh };
  });
  return {
    file,
    width: canvas.width,
    height: canvas.height,
    thumb: URL.createObjectURL(thumb),
    straightened: tiltDeg,
    keystone: keystone || undefined,
    original: base,
    analysis: p.analysis && { ...p.analysis, faces },
  };
}

/** A quick, exact preview of leveling (same math as the real thing) on the small thumbnail. */
export async function previewLevel(thumb: string, tiltDeg: number, keystone: number) {
  const { canvas } = await renderLevel(await fetch(thumb).then((r) => r.blob()), tiltDeg, keystone, 640);
  return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
}

export function unstraighten(p: Photo): Partial<Photo> {
  if (!p.original) return {};
  const o = p.original;
  return {
    file: o.file,
    width: o.width,
    height: o.height,
    thumb: o.thumb,
    straightened: undefined,
    keystone: undefined,
    original: undefined,
    analysis: p.analysis && { ...p.analysis, faces: o.faces },
  };
}

/**
 * Straightens, then re-measures the result and corrects what's left. Edge-based angle estimates
 * run a little short, so a couple of passes land much closer to truly level.
 */
export async function level(p: Photo, tiltDeg: number, keystone = 0): Promise<Partial<Photo>> {
  let angle = tiltDeg;
  let patch = await straighten(p, angle, keystone);
  for (let pass = 0; pass < 3 && tiltDeg; pass++) {
    const m = await measure(await fetch(patch.thumb!).then((r) => r.blob()));
    // Only top up an under-correction measured from the same kind of evidence; a reading that
    // points the other way, or jumps, means it latched onto something else — stop there.
    if (!m || Math.abs(m.tilt) < 0.2 || m.tiltConfidence < 0.3) break;
    if (Math.sign(m.tilt) !== Math.sign(tiltDeg) || Math.abs(m.tilt) > 0.5 * Math.abs(tiltDeg)) break;
    if (p.analysis?.tiltSource === 'horizon' && m.tiltSource !== 'horizon') break;
    angle += m.tilt;
    URL.revokeObjectURL(patch.thumb!);
    patch = await straighten(p, angle, keystone);
  }
  return patch;
}
