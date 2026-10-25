// Classic image metrics on a small copy of each photo. Pure pixel math, no models, no DOM,
// so it runs in a worker and can be tested directly.

export interface TechResult {
  id: string;
  /** Coarse 8×8 Lab layout plus a color histogram: a cheap "what does this look like" fingerprint. */
  grid: number[];
  hist: number[];
  /** 8×8 busy-ness map (edge detail, 0 calm … 1 busy): where another photo can sit without covering anything. */
  detail: number[];
  sharpness: number;
  exposure: number;
  contrast: number;
  colorfulness: number;
  lab: [number, number, number];
  palette: string[];
  hash: string;
  flatness: number;
  coverage: number;
  /** Degrees the scene's horizon/verticals are rotated (y-down), and how sure we are (0..1). */
  tilt: number;
  tiltConfidence: number;
  /** What the angle came from: the horizon (most trusted), other long lines, or objects only. */
  tiltSource: 'horizon' | 'lines' | 'objects' | 'none';
  /** Lean of vertical edges at the frame's sides (degrees): converging verticals from looking up/down. */
  keystone: number;
  keystoneConfidence: number;
  notes: string[];
}

export function analyze(img: { data: Uint8ClampedArray; width: number; height: number }): Omit<TechResult, 'id'> {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const lum = new Float32Array(n);
  const hist = new Uint32Array(256);
  let rgSum = 0, ybSum = 0, rgSq = 0, ybSq = 0, flat = 0;
  let L = 0, A = 0, B = 0;
  const bins = new Map<number, number>();
  const grid = new Float64Array(8 * 8 * 4);
  const colorHist = new Float64Array(64);

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
    const cell = (Math.min(7, Math.floor(((i / w) | 0) * 8 / h)) * 8 + Math.min(7, Math.floor((i % w) * 8 / w))) * 4;
    grid[cell] += l; grid[cell + 1] += a; grid[cell + 2] += bb; grid[cell + 3]++;
    colorHist[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)]++;
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
    grid: Array.from({ length: 64 }, (_, c) => {
      const k = Math.max(1, grid[c * 4 + 3]);
      return [grid[c * 4] / k, grid[c * 4 + 1] / k, grid[c * 4 + 2] / k];
    }).flat().map((v) => Math.round(v * 10) / 10),
    hist: Array.from(colorHist, (v) => Math.round(Math.sqrt(v / n) * 1000) / 1000),
    detail: detailMap(lum, w, h),
    ...tiltAndKeystone(lum, w, h),
    flatness: flat / n,
    coverage,
    notes,
  };
}

/**
 * Tilt from long straight lines (Hough transform). Each strong edge pixel votes for lines through
 * it near its own direction; real straight structures (horizon, buildings, door frames, table
 * edges) pile up votes, while textures like grass, fur or fabric don't. The dominant line angles,
 * weighted by length, give the camera roll. Near-vertical lines count a little less, because
 * looking up or down makes them converge (keystoning).
 */
export function estimateTilt(lum: Float32Array, w: number, h: number, debug?: { lines?: unknown[]; all?: TiltLine[]; edges?: number; thresh?: number }) {
  const RANGE = 30, STEP = 0.25, NT = Math.round((2 * RANGE) / STEP) + 1;
  const D = Math.ceil(Math.hypot(w, h)), RB = 2, NR = Math.ceil((2 * D) / RB) + 1;
  const accH = new Float32Array(NT * NR), accV = new Float32Array(NT * NR);
  const cosT = new Float64Array(NT), sinT = new Float64Array(NT);
  for (let t = 0; t < NT; t++) {
    const a = ((-RANGE + t * STEP) * Math.PI) / 180;
    cosT[t] = Math.cos(a);
    sinT[t] = Math.sin(a);
  }
  const gxs = new Float32Array(w * h), gys = new Float32Array(w * h), mags: number[] = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gxs[i] = lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1];
      gys[i] = lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1];
      if ((x * 7 + y) % 5 === 0) mags.push(Math.hypot(gxs[i], gys[i]));
    }
  mags.sort((a, b) => a - b);
  const thresh = Math.max(40, mags[Math.floor(mags.length * 0.8)] ?? 40);
  const cx = w / 2, cy = h / 2;
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const m = Math.hypot(gxs[i], gys[i]);
      if (m < thresh) continue;
      // Thin edges: keep only local maxima across the edge.
      const ux = Math.round(gxs[i] / m), uy = Math.round(gys[i] / m);
      const j = i + uy * w + ux, k = i - uy * w - ux;
      if (Math.hypot(gxs[j], gys[j]) > m || Math.hypot(gxs[k], gys[k]) > m) continue;
      let e = (Math.atan2(gys[i], gxs[i]) * 180) / Math.PI - 90;
      while (e <= -90) e += 180;
      while (e > 90) e -= 180;
      const vertical = Math.abs(e) > 90 - RANGE;
      if (!vertical && Math.abs(e) > RANGE) continue;
      const dev = vertical ? e - Math.sign(e) * 90 : e;
      const acc = vertical ? accV : accH;
      const t0 = Math.max(0, Math.round((dev - 3 + RANGE) / STEP)), t1 = Math.min(NT - 1, Math.round((dev + 3 + RANGE) / STEP));
      const px = x - cx, py = y - cy;
      for (let t = t0; t <= t1; t++) {
        // Distance of the line from the center: horizontal family has normal (-sin, cos);
        // vertical family is the same lines turned 90°.
        const r = vertical ? px * cosT[t] + py * sinT[t] : -px * sinT[t] + py * cosT[t];
        acc[t * NR + Math.round((r + D) / RB)] += 1;
      }
    }
  // Peaks = lines; votes ≈ length in pixels.
  type Line = TiltLine;
  const lines: Line[] = [];
  const minLen = Math.max(30, Math.min(w, h) * 0.1);
  for (const [acc, vertical] of [[accH, false], [accV, true]] as const) {
    for (let t = 1; t < NT - 1; t++)
      for (let r = 1; r < NR - 1; r++) {
        const v = acc[t * NR + r];
        if (v < minLen) continue;
        let isMax = true;
        for (let dt = -2; dt <= 2 && isMax; dt++)
          for (let dr = -2; dr <= 2; dr++) {
            const tt = t + dt, rr = r + dr;
            if ((dt || dr) && tt >= 0 && tt < NT && rr >= 0 && rr < NR && acc[tt * NR + rr] > v) { isMax = false; break; }
          }
        if (isMax) lines.push({ dev: -RANGE + t * STEP, len: v, vertical, offset: r * RB - D });
      }
  }
  lines.sort((a, b) => b.len - a.len);
  if (debug) debug.all = lines;
  if (!lines.length) {
    if (debug) Object.assign(debug, { lines: [], thresh });
    return { tilt: 0, tiltConfidence: 0, tiltSource: 'none' as const };
  }

  // 1. The horizon outranks everything: a long near-horizontal line across most of the frame
  //    with a clear change above vs. below it (sky/land, land/water). Objects can lean; it can't.
  const sideMeans = (l: Line) => {
    const t = ((l.dev * Math.PI) / 180), c = Math.cos(t), sn = Math.sin(t);
    let up = 0, down = 0, k = 0, roughUp = 0, roughDown = 0, edge = 0;
    for (let x = 4; x < w - 4; x += 4) {
      const px = x - cx;
      const y = cy + (l.offset + px * sn) / c;
      const ya = Math.round(y - 10), yb = Math.round(y + 10);
      if (ya < 0 || yb >= h) continue;
      up += lum[ya * w + x];
      down += lum[yb * w + x];
      // Whether the edge is really there at this point (a horizon runs across the whole frame;
      // an object's edge stops where the object ends).
      if (Math.abs(lum[Math.round(y - 4) * w + x] - lum[Math.round(y + 4) * w + x]) > 10) edge++;
      // Texture just above and below: a real horizon has a calm side (sky, water, haze).
      for (const d of [8, 14, 20]) {
        const ra = Math.round(y - d), rb = Math.round(y + d);
        if (ra >= 0) roughUp += Math.abs(lum[ra * w + x + 1] - lum[ra * w + x - 1]);
        if (rb < h) roughDown += Math.abs(lum[rb * w + x + 1] - lum[rb * w + x - 1]);
      }
      k++;
    }
    const calm = Math.min(roughUp, roughDown) / Math.max(1e-6, roughUp, roughDown);
    // …and a textured side (land, waves, trees): an edge between two plain areas is an object.
    const texture = k ? Math.max(roughUp, roughDown) / (3 * k) : 0;
    return k
      ? { contrast: Math.abs(up - down) / k / 255, coverage: (k * 4) / w, calm, texture, across: edge / k }
      : { contrast: 0, coverage: 0, calm: 1, texture: 0, across: 0 };
  };
  const horizons = lines
    .filter((l) => !l.vertical && l.len >= 0.45 * w)
    .map((l) => ({ l, ...sideMeans(l) }))
    .filter((x) => x.contrast >= 0.06 && x.coverage >= 0.6 && Math.abs(x.l.offset) < 0.4 * h && x.calm < 0.75 && x.texture >= 0.8 && x.across >= 0.7)
    .sort((a, b) => b.l.len * b.contrast - a.l.len * a.contrast);
  if (debug) Object.assign(debug, { lines: lines.slice(0, 12), thresh, horizon: horizons[0] });
  if (horizons.length) {
    const hz = horizons[0];
    // Other long horizontals agreeing with it (shorelines, far rooftops) refine the angle.
    const with_ = lines.filter((l) => !l.vertical && l.len >= 0.2 * w && Math.abs(l.dev - hz.l.dev) <= 0.5);
    const tilt = with_.reduce((a, l) => a + l.dev * l.len, 0) / with_.reduce((a, l) => a + l.len, 0);
    const strength = Math.min(1, (hz.l.len / w) * 1.2) * Math.min(1, hz.contrast * 6);
    return { tilt, tiltConfidence: Math.min(1, 0.35 + 0.65 * strength), tiltSource: 'horizon' as const };
  }

  // 2. No horizon: long horizontal lines of the landscape lead; verticals (often objects, or
  //    leaning from keystoning) count far less; short object edges barely count.
  const top = lines.slice(0, 24);
  const weight = (l: Line) => {
    const span = Math.min(1, l.len / (l.vertical ? h : w));
    return l.len * l.len * span * (l.vertical ? 0.33 * (1 - Math.min(0.6, Math.abs(l.offset) / w)) : 1);
  };
  // Weighted mode: the angle most of the long-line length agrees on (±0.75°).
  let best = 0, bestW = -1;
  for (const c of top) {
    const s = top.reduce((acc, l) => acc + (Math.abs(l.dev - c.dev) <= 0.75 ? weight(l) : 0), 0);
    if (s > bestW) [best, bestW] = [c.dev, s];
  }
  const agree = top.filter((l) => Math.abs(l.dev - best) <= 0.75);
  const tilt = agree.reduce((a, l) => a + l.dev * weight(l), 0) / agree.reduce((a, l) => a + weight(l), 0);
  const total = top.reduce((a, l) => a + weight(l), 0);
  // Sure when the long lines agree with each other, and there's real line length behind the answer.
  const agreement = bestW / total;
  const agreeLen = agree.reduce((a, l) => a + l.len, 0);
  const support = Math.min(1, agreeLen / (0.45 * (w + h)));
  // Several separate lines agreeing is much stronger evidence than one long edge.
  const corroboration = Math.min(1, 0.55 + 0.15 * (agree.length - 1));
  const hasV = agree.some((l) => l.vertical), hasH = agree.some((l) => !l.vertical);
  const both = hasV && hasH ? 1.2 : hasV ? 0.8 : 1;
  return {
    tilt,
    tiltConfidence: Math.min(1, agreement * support * corroboration * both * 1.3),
    // Horizontals and verticals agreeing means a whole scene (a street, a room) lines up; anything
    // less may just be one object's edges.
    tiltSource: (hasH && hasV ? 'lines' : 'objects') as 'lines' | 'objects',
  };
}

export type TiltLine = { dev: number; len: number; vertical: boolean; offset: number };

/**
 * Horizon finder: the straight line across the frame that best separates two consistently
 * different regions (sky over land, land over water). Works on soft, hazy horizons that edge
 * detectors only see in fragments, and ignores textured edges (their contrast flips sign).
 */
export function findHorizon(lum: Float32Array, w: number, h: number) {
  // Work small: ~200 px wide.
  const k = Math.max(1, Math.floor(w / 200));
  const W = Math.floor(w / k), H = Math.floor(h / k);
  const L = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += lum[(y * k + j) * w + x * k + i];
      L[y * W + x] = s / (k * k);
    }
  const cx = W / 2;
  const B = 2; // band offset (px) above/below the line
  const score = (deg: number, y0: number) => {
    const t = Math.tan((deg * Math.PI) / 180);
    let sum = 0, n = 0, cover = 0;
    for (let x = 1; x < W - 1; x += 1) {
      const y = y0 + (x - cx) * t;
      const ya = Math.round(y - B), yb = Math.round(y + B);
      if (ya < 1 || yb >= H - 1) continue;
      cover++;
      const up = (L[(ya - 1) * W + x] + L[ya * W + x]) / 2, dn = (L[(yb + 1) * W + x] + L[yb * W + x]) / 2;
      sum += up - dn;
      n++;
    }
    return { s: n ? Math.abs(sum / n) : 0, sign: Math.sign(sum), cover: cover / (W - 2) };
  };
  let best = { deg: 0, y0: 0, s: 0 };
  for (let deg = -12; deg <= 12.001; deg += 0.5)
    for (let y0 = Math.round(H * 0.1); y0 <= H * 0.9; y0++) {
      const r = score(deg, y0);
      if (r.cover < 0.85) continue;
      if (r.s > best.s) best = { deg, y0, s: r.s };
    }
  // Refine angle finely around the peak.
  for (let deg = best.deg - 0.5; deg <= best.deg + 0.5001; deg += 0.1)
    for (let y0 = best.y0 - 2; y0 <= best.y0 + 2; y0++) {
      const r = score(deg, y0);
      if (r.cover >= 0.85 && r.s > best.s) best = { deg, y0, s: r.s };
    }
  // Sharpness: how much worse the same line is when turned by 2-3°. A real horizon is a straight
  // line: turning it smears the step. A gradual tone change (sky gradient) doesn't care.
  let off = 0;
  for (const dd of [-3, -2, 2, 3]) {
    let m = 0;
    for (let y0 = best.y0 - 3; y0 <= best.y0 + 3; y0++) m = Math.max(m, score(best.deg + dd, y0).s);
    off = Math.max(off, m);
  }
  const sharp = best.s > 0 ? 1 - off / best.s : 0;
  // Continuity: share of columns where the step is clearly there with the same sign.
  const t = Math.tan((best.deg * Math.PI) / 180);
  const sign = Math.sign(score(best.deg, best.y0).sign || 1);
  let cont = 0, cols = 0, roughUp = 0, roughDn = 0;
  for (let x = 1; x < W - 1; x++) {
    const y = best.y0 + (x - cx) * t;
    const ya = Math.round(y - B), yb = Math.round(y + B);
    if (ya < 4 || yb >= H - 4) continue;
    cols++;
    if ((L[ya * W + x] - L[yb * W + x]) * sign > 6) cont++;
    for (const d of [2, 4]) {
      roughUp += Math.abs(L[(ya - d) * W + x + 1] - L[(ya - d) * W + x - 1]);
      roughDn += Math.abs(L[(yb + d) * W + x + 1] - L[(yb + d) * W + x - 1]);
    }
  }
  const continuity = cols ? cont / cols : 0;
  const calm = Math.min(roughUp, roughDn) / Math.max(1e-6, roughUp, roughDn);
  return { tilt: best.deg, strength: best.s, sharp, continuity, calm, y: (best.y0 * k) / h };
}

/**
 * Tilt from long vertical lines (buildings, door frames, poles), favoring the central ones:
 * looking up or down makes the side ones lean in a fan, the middle ones much less.
 */
function verticalTilt(lines: TiltLine[], w: number, h: number) {
  const vs = lines.filter((l) => l.vertical && l.len >= 0.15 * h);
  if (vs.length < 3) return null;
  const wt = (l: TiltLine) => l.len * l.len * Math.max(0.15, 1 - Math.abs(l.offset) / (w / 2));
  let best = 0, bestW = -1;
  for (const c of vs) {
    const s = vs.reduce((a, l) => a + (Math.abs(l.dev - c.dev) <= 0.75 ? wt(l) : 0), 0);
    if (s > bestW) [best, bestW] = [c.dev, s];
  }
  const agree = vs.filter((l) => Math.abs(l.dev - best) <= 0.75);
  const support = agree.reduce((a, l) => a + l.len, 0) / h;
  if (agree.length < 3 || support < 1.2) return null;
  return { tilt: agree.reduce((a, l) => a + l.dev * wt(l), 0) / agree.reduce((a, l) => a + wt(l), 0), support };
}

/**
 * Which way is level, and how sure. Measured on real photos (rotated by known angles):
 *  - A horizon seen as one clean step across nearly the whole width (sky/land, land/water) is
 *    accurate to well under a degree — the only evidence trusted to straighten on its own.
 *  - Vertical lines and partial horizons are often thrown off by perspective (streets, rooms) by
 *    2–3°, so they only ever lead to a question, never an automatic change.
 *  - Angles from objects alone are ignored.
 */
function tiltAndKeystone(lum: Float32Array, w: number, h: number) {
  const dbg: { all?: TiltLine[] } = {};
  const lines = estimateTilt(lum, w, h, dbg);
  const hz = findHorizon(lum, w, h);
  const v = verticalTilt(dbg.all ?? [], w, h);
  const placed = hz.y > 0.06 && hz.y < 0.86 && hz.strength >= 15;
  const agrees = !v || Math.abs(v.tilt - hz.tilt) <= 1.5;
  let t: { tilt: number; tiltConfidence: number; tiltSource: 'horizon' | 'lines' | 'objects' | 'none' };
  if (placed && agrees && hz.continuity >= 0.9) t = { tilt: hz.tilt, tiltConfidence: 0.9, tiltSource: 'horizon' };
  else if (placed && agrees && hz.continuity >= 0.8) t = { tilt: hz.tilt, tiltConfidence: 0.6, tiltSource: 'horizon' };
  // Building lines count only when horizontals agree too (a facade, a room); tree trunks alone don't.
  else if (v && lines.tiltSource === 'lines' && Math.abs(lines.tilt - v.tilt) <= 1.5) t = { tilt: v.tilt, tiltConfidence: Math.min(0.7, 0.4 + v.support * 0.1), tiltSource: 'lines' };
  else t = { tilt: lines.tilt, tiltConfidence: Math.min(0.3, lines.tiltConfidence), tiltSource: lines.tiltSource === 'none' ? 'none' : 'objects' };
  return { ...t, ...estimateKeystone(dbg.all ?? [], w, h, t.tilt) };
}

/**
 * Keystone ("skew"): when the camera looks up or down, vertical edges lean in a fan, the left
 * ones one way and the right ones the other, more so toward the sides. Fit each vertical line's
 * lean (after removing the overall tilt) against its position across the frame; the slope is
 * the keystone, in degrees of lean at the frame's edge.
 */
export function estimateKeystone(lines: TiltLine[], w: number, h: number, tilt: number) {
  const vs = lines.filter((l) => l.vertical && l.len >= 0.12 * h && Math.abs(l.dev - tilt) < 20).slice(0, 30);
  const left = vs.filter((l) => l.offset < -0.12 * w).length, right = vs.filter((l) => l.offset > 0.12 * w).length;
  if (vs.length < 3 || !left || !right) return { keystone: 0, keystoneConfidence: 0 };
  // Weighted least squares: lean = a + b·u, with u = position across the frame (-1 … 1).
  let sw = 0, su = 0, sd = 0, suu = 0, sud = 0;
  for (const l of vs) {
    const u = l.offset / (w / 2), d = l.dev - tilt, wt = l.len;
    sw += wt; su += wt * u; sd += wt * d; suu += wt * u * u; sud += wt * u * d;
  }
  const den = sw * suu - su * su;
  if (den <= 1e-9) return { keystone: 0, keystoneConfidence: 0 };
  const b = (sw * sud - su * sd) / den, a = (sd - b * su) / sw;
  let res = 0, tot = 0;
  for (const l of vs) {
    const u = l.offset / (w / 2), d = l.dev - tilt;
    res += l.len * (d - a - b * u) ** 2;
    tot += l.len * (d - sd / sw) ** 2;
  }
  const fit = tot > 1e-9 ? Math.max(0, 1 - res / tot) : 0;
  const support = Math.min(1, vs.reduce((t, l) => t + l.len, 0) / (1.5 * h));
  return { keystone: b, keystoneConfidence: Math.min(1, fit * support * Math.min(1, Math.min(left, right) / 2)) };
}

/** Mean gradient strength per cell of an 8×8 grid, scaled so ~1 is very busy. Sky, water, fog → ~0. */
function detailMap(lum: Float32Array, w: number, h: number) {
  const sum = new Float64Array(64), cnt = new Float64Array(64);
  for (let y = 1; y < h - 1; y += 2)
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      const g = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + w] - lum[i - w]);
      const c = Math.min(7, Math.floor((y * 8) / h)) * 8 + Math.min(7, Math.floor((x * 8) / w));
      sum[c] += g;
      cnt[c]++;
    }
  return Array.from(sum, (v, c) => Math.round(Math.min(1, v / Math.max(1, cnt[c]) / 40) * 100) / 100);
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
