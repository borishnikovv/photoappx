import exifr from 'exifr';
import type { Photo } from '../types';
import { uid } from './geometry';

const IMAGE_RE = /\.(jpe?g|png|webp|heic|heif|avif|tiff?)$/i;
const HEIC_RE = /\.(heic|heif)$/i;

export const isImageName = (name: string) => IMAGE_RE.test(name) && !name.startsWith('._');

/** Converts HEIC to JPEG when the browser can't decode it (everything but Safari). */
async function decodable(file: Blob, name: string): Promise<Blob> {
  if (!HEIC_RE.test(name) && !/hei[cf]/.test(file.type)) return file;
  try {
    await createImageBitmap(file).then((b) => b.close());
    return file;
  } catch {
    const { default: heic2any } = await import('heic2any');
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    return Array.isArray(out) ? out[0] : out;
  }
}

export async function downscale(src: Blob | ImageBitmap, maxEdge: number, quality = 0.85) {
  const bmp = src instanceof ImageBitmap ? src : await createImageBitmap(src);
  const s = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { blob, canvas, width: bmp.width, height: bmp.height, bmp };
}

export async function loadPhoto(file: Blob, name: string, source: Photo['source'], fallbackDate = Date.now()): Promise<Photo> {
  const blob = await decodable(file, name);
  const [meta, scaled] = await Promise.all([
    exifr.parse(file, ['DateTimeOriginal', 'CreateDate', 'Make', 'Model']).catch(() => null),
    downscale(blob, 640, 0.82),
  ]);
  scaled.bmp.close();
  const d: Date | undefined = meta?.DateTimeOriginal ?? meta?.CreateDate;
  return {
    id: uid('ph'),
    name,
    source,
    file: blob,
    width: scaled.width,
    height: scaled.height,
    date: d instanceof Date && !isNaN(+d) ? +d : fallbackDate,
    camera: [meta?.Make, meta?.Model].filter(Boolean).join(' ') || undefined,
    thumb: URL.createObjectURL(scaled.blob),
  };
}

/** Loads files a few at a time, reporting progress. Unreadable files are skipped. */
export async function loadFiles(
  entries: { file: Blob | (() => Promise<Blob>); name: string; date?: number }[],
  source: Photo['source'],
  onProgress: (done: number, total: number, photo?: Photo) => void,
) {
  const list = entries.filter((e) => isImageName(e.name) || (e.file instanceof Blob && e.file.type.startsWith('image/')));
  const total = list.length;
  let done = 0;
  const out: Photo[] = [];
  const worker = async () => {
    while (list.length) {
      const e = list.shift()!;
      try {
        const blob = e.file instanceof Blob ? e.file : await e.file();
        const p = await loadPhoto(blob, e.name, source, e.date);
        out.push(p);
        onProgress(++done, total, p);
      } catch (err) {
        console.warn('Skipping', e.name, err);
        onProgress(++done, total);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out.sort((a, b) => a.date - b.date);
}

/** Cached mid-resolution previews for the editor, so the DOM never holds full-size originals. */
const previews = new WeakMap<Blob, Promise<string>>();
export function previewUrl(p: Photo) {
  // Keyed by file so a straightened (replaced) image gets a fresh preview.
  let u = previews.get(p.file);
  if (!u) {
    u = downscale(p.file, 1800, 0.88).then((s) => {
      s.bmp.close();
      return URL.createObjectURL(s.blob);
    });
    previews.set(p.file, u);
  }
  return u;
}
