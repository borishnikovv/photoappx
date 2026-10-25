/// <reference lib="webworker" />
// Runs the image metrics off the main thread.
import { analyze } from '../lib/metrics';
export type { TechResult } from '../lib/metrics';

/** Analysis resolution: enough for sharp line angles, small enough to be quick. */
const SIZE = 512;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<{ id: string; blob: Blob }>) => {
  const { id, blob } = e.data;
  try {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, SIZE / Math.max(bmp.width, bmp.height));
    const w = Math.max(9, Math.round(bmp.width * s)), h = Math.max(8, Math.round(bmp.height * s));
    const c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
    c.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    ctx.postMessage({ id, ...analyze(c.getImageData(0, 0, w, h)) });
  } catch (err) {
    ctx.postMessage({ id, error: String(err) });
  }
};
