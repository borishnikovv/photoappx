// Color grading: one shared look across the carousel, tones matched between photos, and optional
// black-and-white accents. The same numbers drive the live preview (an SVG color-matrix filter)
// and the export (applied per pixel), so what you see is what you post.
import type { Photo, StyleOptions } from '../types';

export type Look = 'natural' | 'warm' | 'film' | 'matte' | 'bw';

export interface Grade {
  /** 3×3 color matrix, row-major, applied to sRGB values 0..1. */
  m: number[];
  /** Tone curve (linear): out = slope · in + intercept. Lifts blacks for fade, sets contrast. */
  slope: number;
  intercept: number;
}

const LUM = [0.2126, 0.7152, 0.0722];
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const mul = (a: number[], b: number[]) =>
  [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]));
const diag = (r: number, g: number, b: number) => [r, 0, 0, 0, g, 0, 0, 0, b];
const saturation = (s: number) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => (1 - s) * LUM[c] + (r === c ? s : 0)));

/** Each look: channel balance, saturation, contrast and how much the blacks are lifted (fade). */
const LOOKS: Record<Look, { rgb: [number, number, number]; sat: number; contrast: number; fade: number }> = {
  natural: { rgb: [1, 1, 1], sat: 1, contrast: 1, fade: 0 },
  warm: { rgb: [1.05, 1.01, 0.92], sat: 0.96, contrast: 1.03, fade: 0 },
  film: { rgb: [1.03, 1, 0.95], sat: 0.86, contrast: 0.95, fade: 0.05 },
  matte: { rgb: [1, 1, 1], sat: 0.84, contrast: 0.9, fade: 0.08 },
  bw: { rgb: [1, 1, 1], sat: 0, contrast: 1.08, fade: 0.02 },
};
export const LOOK_NAMES: { id: Look; label: string }[] = [
  { id: 'natural', label: 'Natural' },
  { id: 'warm', label: 'Warm' },
  { id: 'film', label: 'Film' },
  { id: 'matte', label: 'Matte' },
  { id: 'bw', label: 'B&W' },
];

function labToRgb(L: number, a: number, b: number) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = 0.95047 * f(fx), Y = f(fy), Z = 1.08883 * f(fz);
  const lin = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
  return lin.map((v) => Math.max(0.001, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
}

/** What the set looks like overall: its typical brightness, for matching exposure. */
export function albumTone(photos: Photo[]) {
  const Ls = photos.map((p) => p.analysis?.lab?.[0]).filter((v): v is number => v != null).sort((a, b) => a - b);
  return { L: Ls.length ? Ls[Ls.length >> 1] : 50 };
}

/**
 * The grade for one photo: tone matching (a gentle pull of its color cast and brightness toward
 * the set), then the look, then black-and-white if this frame is an accent.
 */
export function gradeFor(p: Photo, style: StyleOptions, tone: { L: number }, mono = false): Grade {
  let m = IDENT;
  if (style.matchTones !== false && p.analysis?.lab) {
    const [L, a, b] = p.analysis.lab;
    const [r, g, bl] = labToRgb(L, a, b);
    const avg = (r + g + bl) / 3;
    const k = (v: number) => Math.min(1.08, Math.max(0.92, (avg / v) ** 0.3));
    const e = Math.min(1.15, Math.max(0.88, (Math.max(5, tone.L) / Math.max(5, L)) ** 0.35));
    m = diag(k(r) * e, k(g) * e, k(bl) * e);
  }
  const look = LOOKS[style.look ?? 'natural'];
  m = mul(mul(saturation(look.sat), diag(...look.rgb)), m);
  let contrast = look.contrast, fade = look.fade;
  if (mono && style.look !== 'bw') {
    m = mul(saturation(0), m);
    contrast *= 1.06;
  }
  if (fade === 0 && contrast === 1 && m.every((v, i) => Math.abs(v - IDENT[i]) < 1e-4)) return { m: IDENT, slope: 1, intercept: 0 };
  fade = Math.max(0, fade);
  return { m, slope: contrast * (1 - fade), intercept: fade + (1 - fade) * (0.5 - 0.5 * contrast) };
}

export const isIdentity = (g: Grade) => g.slope === 1 && g.intercept === 0 && g.m.every((v, i) => v === IDENT[i]);

/** SVG feColorMatrix values (4×5) for the preview filter. */
export function svgMatrix(g: Grade) {
  const { m, slope: s, intercept: t } = g;
  return [
    ...[m[0] * s, m[1] * s, m[2] * s, 0, t],
    ...[m[3] * s, m[4] * s, m[5] * s, 0, t],
    ...[m[6] * s, m[7] * s, m[8] * s, 0, t],
    ...[0, 0, 0, 1, 0],
  ]
    .map((v) => +v.toFixed(5))
    .join(' ');
}

/** Applies a grade to pixels in place (export path). */
export function applyGrade(data: Uint8ClampedArray, g: Grade) {
  if (isIdentity(g)) return;
  const { m, slope: s, intercept: t } = g;
  const T = t * 255;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], gg = data[i + 1], b = data[i + 2];
    data[i] = (m[0] * r + m[1] * gg + m[2] * b) * s + T;
    data[i + 1] = (m[3] * r + m[4] * gg + m[5] * b) * s + T;
    data[i + 2] = (m[6] * r + m[7] * gg + m[8] * b) * s + T;
  }
}
