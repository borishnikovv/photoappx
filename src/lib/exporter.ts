import JSZip from 'jszip';
import type { Carousel, Photo, StyleOptions } from '../types';
import { SLIDE_H, SLIDE_W, absoluteItems, backgroundOf, slideCount, sourceRect } from './geometry';
import { albumTone, applyGrade, gradeFor, isIdentity } from './grade';

const BLEED = 4;
/** Instagram re-compresses every upload and softens it; a light unsharp mask holds the detail. */
const SHARPEN = 0.35;

/** Unsharp mask (3×3 blur), skipping tiny differences so flat skies and noise stay clean. */
export function sharpen(img: ImageData, amount: number, threshold = 3) {
  const { width: w, height: h, data } = img;
  const src = new Uint8ClampedArray(data);
  const row = w * 4;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * row + x * 4;
      for (let c = 0; c < 3; c++) {
        const k = i + c;
        const blur =
          (4 * src[k] + 2 * (src[k - 4] + src[k + 4] + src[k - row] + src[k + row]) + src[k - row - 4] + src[k - row + 4] + src[k + row - 4] + src[k + row + 4]) / 16;
        const d = src[k] - blur;
        if (d > threshold || d < -threshold) data[k] = src[k] + amount * d;
      }
    }
}

/**
 * Renders each slide at exactly 1080x1350. Photos are decoded once at the resolution they're
 * actually shown at, and released after the last slide that uses them.
 */
export async function renderSlides(c: Carousel, photos: Map<string, Photo>, o: StyleOptions, onProgress?: (i: number, n: number) => void) {
  const items = absoluteItems(c);
  const bg = backgroundOf(o, c);
  const tone = albumTone([...new Set(items.map((i) => i.photoId))].map((id) => photos.get(id)!).filter(Boolean));
  const n = slideCount(c);
  const lastUse = new Map<string, number>();
  const needW = new Map<string, number>();
  for (const it of items) {
    const p = photos.get(it.photoId)!;
    const { sw } = sourceRect(p, it);
    lastUse.set(it.photoId, Math.max(lastUse.get(it.photoId) ?? 0, Math.floor((it.ax + it.w - 1 + BLEED) / SLIDE_W)));
    needW.set(it.photoId, Math.max(needW.get(it.photoId) ?? 0, Math.min(p.width, Math.ceil(it.w / sw))));
  }
  const bitmaps = new Map<string, Promise<ImageBitmap>>();
  const bitmap = (id: string) => {
    let b = bitmaps.get(id);
    if (!b) {
      const p = photos.get(id)!;
      const w = needW.get(id)!;
      b = createImageBitmap(p.file, w < p.width ? { resizeWidth: w, resizeQuality: 'high' } : {});
      bitmaps.set(id, b);
    }
    return b;
  };

  const out: Blob[] = [];
  // Each slide is drawn with a few pixels of its neighbors around it, so sharpening sees the
  // same pixels on both sides of a cut and the seam stays invisible.
  const canvas = new OffscreenCanvas(SLIDE_W + 2 * BLEED, SLIDE_H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  const slide = document.createElement('canvas');
  slide.width = SLIDE_W;
  slide.height = SLIDE_H;
  const sctx = slide.getContext('2d')!;

  for (let i = 0; i < n; i++) {
    const x0 = i * SLIDE_W - BLEED;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, SLIDE_H);
    for (const it of items) {
      if (it.ax >= x0 + canvas.width || it.ax + it.w <= x0) continue;
      const img = await bitmap(it.photoId);
      const { sx, sy, sw, sh } = sourceRect(photos.get(it.photoId)!, it);
      const x = it.ax - x0, y = it.y, b = it.border;
      ctx.save();
      if (it.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = 40;
        ctx.shadowOffsetY = 14;
      }
      ctx.fillStyle = b ? o.frame : bg;
      if (b || it.shadow) ctx.fillRect(x - b, y - b, it.w + 2 * b, it.h + 2 * b);
      ctx.restore();
      const grade = gradeFor(photos.get(it.photoId)!, o, tone, it.mono);
      if (isIdentity(grade)) ctx.drawImage(img, sx * img.width, sy * img.height, sw * img.width, sh * img.height, x, y, it.w, it.h);
      else {
        // Grade just this frame's pixels, then lay it on the slide.
        const tw = Math.max(1, Math.round(it.w)), th = Math.max(1, Math.round(it.h));
        const tmp = new OffscreenCanvas(tw, th);
        const tc = tmp.getContext('2d', { willReadFrequently: true })!;
        tc.imageSmoothingQuality = 'high';
        tc.drawImage(img, sx * img.width, sy * img.height, sw * img.width, sh * img.height, 0, 0, tw, th);
        const px = tc.getImageData(0, 0, tw, th);
        applyGrade(px.data, grade);
        tc.putImageData(px, 0, 0);
        ctx.drawImage(tmp, x, y, it.w, it.h);
      }
    }
    const px = ctx.getImageData(0, 0, canvas.width, SLIDE_H);
    sharpen(px, SHARPEN);
    sctx.putImageData(px, -BLEED, 0, BLEED, 0, SLIDE_W, SLIDE_H);
    out.push(await new Promise<Blob>((res) => slide.toBlob((b) => res(b!), 'image/jpeg', 0.95)));
    for (const [id, last] of lastUse)
      if (last === i && bitmaps.has(id)) {
        (await bitmaps.get(id)!).close();
        bitmaps.delete(id);
      }
    onProgress?.(i + 1, n);
  }
  return out;
}

/**
 * The whole carousel as one long image, for a website, a print or a story. Scaled down when
 * needed to stay under ~16 megapixels, the most phones will open.
 */
export async function renderPanorama(slides: Blob[]) {
  const n = slides.length;
  const k = Math.min(1, Math.sqrt(16e6 / (n * SLIDE_W * SLIDE_H)));
  const sw = Math.round(SLIDE_W * k), sh = Math.round(SLIDE_H * k);
  const canvas = document.createElement('canvas');
  canvas.width = sw * n;
  canvas.height = sh;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  for (const [i, b] of slides.entries()) {
    const bmp = await createImageBitmap(b);
    ctx.drawImage(bmp, i * sw, 0, sw, sh);
    bmp.close();
  }
  return new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.92));
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const fileName = (i: number) => `slide-${String(i + 1).padStart(2, '0')}.jpg`;

export async function downloadZip(slides: Blob[], name = 'carousel') {
  const zip = new JSZip();
  slides.forEach((b, i) => zip.file(fileName(i), b));
  downloadBlob(await zip.generateAsync({ type: 'blob' }), `${name}.zip`);
}

/** On phones, the share sheet's "Save Images" drops the slides straight into the camera roll. */
export function canShareFiles() {
  try {
    return !!navigator.canShare?.({ files: [new File([new Blob()], 'x.jpg', { type: 'image/jpeg' })] });
  } catch {
    return false;
  }
}

export async function shareSlides(slides: Blob[]) {
  const files = slides.map((b, i) => new File([b], fileName(i), { type: 'image/jpeg' }));
  await navigator.share({ files });
}
