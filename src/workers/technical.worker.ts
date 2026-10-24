/// <reference lib="webworker" />
// Classic image metrics, computed on a small copy of each photo. Pure pixel math, no models.

export interface TechResult {
  id: string;
  sharpness: number;
  exposure: number;
  contrast: number;
  colorfulness: number;
  lab: [number, number, number];
  palette: string[];
  hash: string;
  flatness: number;
  coverage: number;
  notes: string[];
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<{ id: string; blob: Blob }>) => {
  const { id, blob } = e.data;
  try {
    const bmp = await createImageBitmap(blob);
    const s = 384 / Math.max(bmp.width, bmp.height);
    const w = Math.max(9, Math.round(bmp.width * s)), h = Math.max(8, Math.round(bmp.height * s));
    const c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
    c.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    ctx.postMessage({ id, ...analyze(c.getImageData(0, 0, w, h)) });
  } catch (err) {
    ctx.postMessage({ id, error: String(err) });
  }
};

function analyze(img: ImageData): Omit<TechResult, 'id'> {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const lum = new Float32Array(n);
  const hist = new Uint32Array(256);
  let rgSum = 0, ybSum = 0, rgSq = 0, ybSq = 0, flat = 0;
  let L = 0, A = 0, B = 0;
  const bins = new Map<number, number>();

  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[i] = y;
    hist[Math.min(255, Math.round(y))]++;
    const rg = r - g, yb = 0.5 * (r + g) - b;
    rgSum += rg; ybSum += yb; rgSq += rg * rg; ybSq += yb * yb;
    if (i > 0 && r === data[i * 4 - 4] && g === data[i * 4 - 3] && b === data[i * 4 - 2]) flat++;
    const [l, a, bb] = rgbToLab(r, g, b);
    L += l; A += a; B += bb;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }

  // Sharpness: Laplacian variance per tile, keep the sharpest tiles, so shallow depth of field
  // with a crisp subject still counts as sharp.
  const T = 4, tw = Math.floor(w / T), th = Math.floor(h / T);
  const tileVar: number[] = [];
  for (let ty = 0; ty < T; ty++)
    for (let tx = 0; tx < T; tx++) {
      let s = 0, sq = 0, k = 0;
      for (let y = Math.max(1, ty * th); y < Math.min(h - 1, (ty + 1) * th); y++)
        for (let x = Math.max(1, tx * tw); x < Math.min(w - 1, (tx + 1) * tw); x++) {
          const i = y * w + x;
          const v = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w];
          s += v; sq += v * v; k++;
        }
      if (k) tileVar.push(sq / k - (s / k) ** 2);
    }
  tileVar.sort((a, b) => b - a);
  const peak = (tileVar[0] + (tileVar[1] ?? tileVar[0])) / 2;
  const sharpness = clamp01((Math.log10(peak + 1) - 1.3) / 1.3);

  let mean = 0;
  for (let i = 0; i < 256; i++) mean += i * hist[i];
  mean /= n;
  let varL = 0;
  for (let i = 0; i < 256; i++) varL += hist[i] * (i - mean) ** 2;
  const contrast = clamp01(Math.sqrt(varL / n) / 70);
  let hi = 0, lo = 0;
  for (let i = 250; i < 256; i++) hi += hist[i];
  for (let i = 0; i < 4; i++) lo += hist[i];
  hi /= n; lo /= n;
  const notes: string[] = [];
  let exposure = 1;
  if (hi > 0.06) { exposure -= Math.min(0.6, (hi - 0.06) * 4); notes.push('Blown highlights'); }
  // Deep shadows are often intentional (low-key, moody), so they cost less.
  if (lo > 0.35) { exposure -= Math.min(0.4, (lo - 0.35) * 1.5); notes.push('Crushed shadows'); }
  if (mean > 225) { exposure -= 0.3; notes.push('Overexposed'); }
  if (mean < 22) { exposure -= 0.3; notes.push('Very dark'); }

  const rgM = rgSum / n, ybM = ybSum / n;
  const std = Math.sqrt(Math.max(0, rgSq / n - rgM * rgM) + Math.max(0, ybSq / n - ybM * ybM));
  const colorfulness = clamp01((std + 0.3 * Math.hypot(rgM, ybM)) / 110);

  const ranked = [...bins.entries()].sort((a, b) => b[1] - a[1]);
  // Share of pixels in the 3 most common coarse colors: very high for UI and graphics.
  const coverage = ranked.slice(0, 3).reduce((s, [, c]) => s + c, 0) / n;
  const palette = ranked
    .slice(0, 5)
    .map(([k]) => {
      const r = ((k >> 6) & 7) * 32 + 16, g = ((k >> 3) & 7) * 32 + 16, b = (k & 7) * 32 + 16;
      return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    });

  return {
    sharpness,
    exposure: clamp01(exposure),
    contrast,
    colorfulness,
    lab: [L / n, A / n, B / n],
    palette,
    hash: dhash(lum, w, h),
    flatness: flat / n,
    coverage,
    notes,
  };
}

/** 64-bit difference hash, as hex, for near-duplicate detection. */
function dhash(lum: Float32Array, w: number, h: number) {
  const g = new Float32Array(72);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 9; x++) {
      let s = 0, k = 0;
      for (let yy = Math.floor((y * h) / 8); yy < Math.floor(((y + 1) * h) / 8); yy++)
        for (let xx = Math.floor((x * w) / 9); xx < Math.floor(((x + 1) * w) / 9); xx++) {
          s += lum[yy * w + xx];
          k++;
        }
      g[y * 9 + x] = s / Math.max(1, k);
    }
  let out = '';
  for (let y = 0; y < 8; y++) {
    let nib = 0;
    for (let x = 0; x < 8; x++) {
      nib = (nib << 1) | (g[y * 9 + x] < g[y * 9 + x + 1] ? 1 : 0);
      if (x % 4 === 3) {
        out += nib.toString(16);
        nib = 0;
      }
    }
  }
  return out;
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
