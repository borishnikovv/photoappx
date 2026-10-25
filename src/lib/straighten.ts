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

/** Returns the fields to merge into the photo: a leveled, cropped copy, keeping the original. */
export async function straighten(p: Photo, tiltDeg: number): Promise<Partial<Photo>> {
  const base = p.original ?? { file: p.file, width: p.width, height: p.height, thumb: p.thumb, faces: p.analysis?.faces };
  const rad = (-tiltDeg * Math.PI) / 180;
  const bmp = await createImageBitmap(base.file);
  const fit = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * fit), h = Math.round(bmp.height * fit);
  const scale = innerScale(w, h, rad);
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(rad);
  ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
  bmp.close();
  const [file, thumb] = await Promise.all([encode(canvas, MAX_EDGE), encode(canvas, 640)]);
  const faces: FaceBox[] | undefined = base.faces?.map((f) => {
    const [cx, cy] = mapPoint(f.x + f.w / 2, f.y + f.h / 2, w, h, rad, scale);
    const fw = f.w / scale, fh = f.h / scale;
    return { ...f, x: cx - fw / 2, y: cy - fh / 2, w: fw, h: fh };
  });
  return {
    file,
    width: cw,
    height: ch,
    thumb: URL.createObjectURL(thumb),
    straightened: tiltDeg,
    original: base,
    analysis: p.analysis && { ...p.analysis, faces },
  };
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
    original: undefined,
    analysis: p.analysis && { ...p.analysis, faces: o.faces },
  };
}

/**
 * Straightens, then re-measures the result and corrects what's left. Edge-based angle estimates
 * run a little short, so a couple of passes land much closer to truly level.
 */
export async function level(p: Photo, tiltDeg: number): Promise<Partial<Photo>> {
  let angle = tiltDeg;
  let patch = await straighten(p, angle);
  for (let pass = 0; pass < 3; pass++) {
    const m = await measure(await fetch(patch.thumb!).then((r) => r.blob()));
    // Only top up an under-correction measured from the same kind of evidence; a reading that
    // points the other way, or jumps, means it latched onto something else — stop there.
    if (!m || Math.abs(m.tilt) < 0.2 || m.tiltConfidence < 0.3) break;
    if (Math.sign(m.tilt) !== Math.sign(tiltDeg) || Math.abs(m.tilt) > 0.5 * Math.abs(tiltDeg)) break;
    if (p.analysis?.tiltSource === 'horizon' && m.tiltSource !== 'horizon') break;
    angle += m.tilt;
    URL.revokeObjectURL(patch.thumb!);
    patch = await straighten(p, angle);
  }
  return patch;
}
