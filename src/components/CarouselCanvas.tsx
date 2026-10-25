import { useEffect, useMemo, useRef, useState } from 'react';
import type { Carousel, Item, Photo, StyleOptions } from '../types';
import { SLIDE_H, SLIDE_W, backgroundOf, clamp, slideCount, sourceRect } from '../lib/geometry';
import { previewUrl } from '../lib/importer';
import { albumTone, gradeFor, isIdentity, svgMatrix } from '../lib/grade';

export type EditMode = 'frame' | 'photo' | 'crop';
type Edge = 'l' | 'r' | 't' | 'b';

function usePreview(p: Photo | undefined) {
  const [url, setUrl] = useState(p?.thumb);
  useEffect(() => {
    if (!p) return;
    let live = true;
    setUrl(p.thumb);
    previewUrl(p).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [p]);
  return url;
}

interface ItemProps {
  item: Item;
  ax: number;
  photo: Photo;
  scale: number;
  style: StyleOptions;
  z: number;
  selected?: boolean;
  editable?: boolean;
  mode?: EditMode;
  onSelect?: () => void;
  onChange?: (patch: Partial<Item>) => void;
  /** Other photos' edges and centers (canvas px), for alignment while dragging. */
  others: Rect[];
  slides: number;
  onGuides: (g: Guides) => void;
  /** SVG filter id carrying this photo's color grade, if any. */
  filter?: string;
  /** Another photo is lining up with this one right now. */
  partner?: boolean;
}

type Rect = { id?: string; x: number; y: number; w: number; h: number };
/** What's drawn while dragging: guide segments, the photos being aligned to, and even gaps. */
export type Guides = {
  lines: { axis: 'x' | 'y'; v: number; from: number; to: number; strong: boolean }[];
  partners: string[];
  gaps: { axis: 'x' | 'y'; a: number; b: number; at: number }[];
};
const NO_GUIDES: Guides = { lines: [], partners: [], gaps: [] };
type Target = { v: number; photo?: Rect; gap?: boolean };

/** The same spacing the layouts use: slide margins and the gap between stacked photos. */
const MARGIN = 80, GAP = 40;

/**
 * The closest alignment for any of an item's edges/center: other photos first (edges, centers,
 * an even gap beside them — they win ties), then slide margins, centers and edges.
 */
function snapBest(vs: number[], targets: Target[], tol: number) {
  let best: { i: number; t: Target; d: number } | null = null;
  vs.forEach((v, i) => {
    for (const t of targets) {
      // Lining up with a photo nearby beats a slide line unless the slide line is much closer.
      const d = Math.abs(v - t.v) - (t.photo ? tol * 0.4 : 0);
      if (Math.abs(v - t.v) < tol && (!best || d < best.d)) best = { i, t, d };
    }
  });
  return best as { i: number; t: Target; d: number } | null;
}

/**
 * Crop by dragging one edge of the frame. The picture stays exactly where it is on the canvas
 * (same scale, same position); only the window onto it changes — like a crop tool.
 */
function cropEdge(photo: Photo, s: Item, edge: Edge, d: number): Partial<Item> {
  const r0 = sourceRect(photo, s);
  const k = s.w / r0.sw; // canvas px per unit of photo width
  const kh = s.h / r0.sh;
  let { x, y, w, h } = s;
  if (edge === 'l') { x += d; w -= d; }
  if (edge === 'r') w += d;
  if (edge === 't') { y += d; h -= d; }
  if (edge === 'b') h += d;
  w = Math.max(120, w);
  h = Math.max(120, h);
  if (edge === 'l') x = s.x + s.w - w;
  if (edge === 't') y = s.y + s.h - h;
  // The new window, in photo units, keeping the picture fixed on the canvas.
  let sx = r0.sx + (x - s.x) / k, sy = r0.sy + (y - s.y) / kh;
  let sw = w / k, sh = h / kh;
  // Can't show more than the whole photo: clamp the frame to the picture's edges.
  if (sx < 0) { w += sx * k; x -= sx * k; sw += sx; sx = 0; }
  if (sy < 0) { h += sy * kh; y -= sy * kh; sh += sy; sy = 0; }
  if (sx + sw > 1) { w -= (sx + sw - 1) * k; sw = 1 - sx; }
  if (sy + sh > 1) { h -= (sy + sh - 1) * kh; sh = 1 - sy; }
  // Express it as a cover crop: zoom relative to the base cover window for this frame shape.
  const cover = sourceRect(photo, { w, h, crop: { fx: 0.5, fy: 0.5, zoom: 1 } });
  const zoom = Math.max(1, cover.sw / sw);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), crop: { fx: sx + sw / 2, fy: sy + sh / 2, zoom } };
}

function PhotoItem({ item, ax, photo, scale, style, z, selected, editable, mode, onSelect, onChange, others, slides, onGuides, filter, partner }: ItemProps) {
  const url = usePreview(photo);
  const drag = useRef<{ x: number; y: number; start: Item; kind: 'move' | 'pan' | 'resize' | Edge } | null>(null);
  const { sx, sy, sw, sh } = sourceRect(photo, item);
  const imgW = (item.w / sw) * scale;
  const imgH = (item.h / sh) * scale;

  const down = (e: React.PointerEvent, kind?: 'resize' | Edge) => {
    if (!editable) return;
    e.stopPropagation();
    onSelect?.();
    (e.target as Element).setPointerCapture(e.pointerId);
    // Backdrops fill their slides, so dragging one pans the photo instead of moving the frame.
    drag.current = { x: e.clientX, y: e.clientY, start: item, kind: kind ?? (mode === 'photo' || item.base ? 'pan' : 'move') };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !onChange) return;
    const dx = (e.clientX - d.x) / scale;
    const dy = (e.clientY - d.y) / scale;
    const s = d.start;
    const tol = 14 / scale;
    if (d.kind === 'l' || d.kind === 'r' || d.kind === 't' || d.kind === 'b') {
      onChange(cropEdge(photo, s, d.kind, d.kind === 'l' || d.kind === 'r' ? dx : dy));
      return;
    }
    if (d.kind === 'pan') {
      // Dragging right reveals more of the photo's left side.
      const fx = clamp(s.crop.fx - (dx / s.w) * sw, sw / 2, 1 - sw / 2);
      const fy = clamp(s.crop.fy - (dy / s.h) * sh, sh / 2, 1 - sh / 2);
      onChange({ crop: { ...s.crop, fx, fy } });
    } else {
      const origin = ax - item.x;
      const L0 = origin + s.x + dx, T0 = s.y + dy;
      // Only photos in the same area count: on the slides this one touches, or right next to it.
      const near = others.filter((o) => o.x < L0 + s.w + SLIDE_W * 0.6 && o.x + o.w > L0 - SLIDE_W * 0.6);
      const xs: Target[] = [], ys: Target[] = [];
      for (let k = 0; k <= slides; k++)
        xs.push({ v: k * SLIDE_W }, { v: k * SLIDE_W + SLIDE_W / 2 }, { v: k * SLIDE_W + MARGIN }, { v: k * SLIDE_W - MARGIN });
      ys.push({ v: 0 }, { v: SLIDE_H }, { v: SLIDE_H / 2 }, { v: MARGIN }, { v: SLIDE_H - MARGIN });
      for (const o of near) {
        xs.push({ v: o.x, photo: o }, { v: o.x + o.w / 2, photo: o }, { v: o.x + o.w, photo: o });
        ys.push({ v: o.y, photo: o }, { v: o.y + o.h / 2, photo: o }, { v: o.y + o.h, photo: o });
      }
      // Edges of this photo that may snap: left/center/right (and top/middle/bottom), plus an
      // even gap to a neighbour on either side.
      const gapX = near.flatMap((o) => [{ v: o.x + o.w + GAP, photo: o, gap: true }, { v: o.x - GAP, photo: o, gap: true }]);
      const gapY = near.flatMap((o) => [{ v: o.y + o.h + GAP, photo: o, gap: true }, { v: o.y - GAP, photo: o, gap: true }]);
      const guidesFor = (hx: ReturnType<typeof snapBest>, hy: ReturnType<typeof snapBest>, x: number, y: number, w: number, h: number): Guides => {
        const g: Guides = { lines: [], partners: [], gaps: [] };
        for (const [hit, axis] of [[hx, 'x'], [hy, 'y']] as const) {
          if (!hit) continue;
          const o = hit.t.photo;
          if (o?.id) g.partners.push(o.id);
          if (hit.t.gap && o) {
            g.gaps.push(
              axis === 'x'
                ? { axis, a: Math.min(x + w, o.x + o.w), b: Math.max(x, o.x), at: Math.max(y, o.y) + Math.min(h, o.h) / 2 }
                : { axis, a: Math.min(y + h, o.y + o.h), b: Math.max(y, o.y), at: Math.max(x, o.x) + Math.min(w, o.w) / 2 },
            );
            continue;
          }
          // A segment spanning both photos (or the whole slide for slide lines).
          const [from, to] = o
            ? axis === 'x' ? [Math.min(y, o.y), Math.max(y + h, o.y + o.h)] : [Math.min(x, o.x), Math.max(x + w, o.x + o.w)]
            : axis === 'x' ? [0, SLIDE_H] : [Math.floor(x / SLIDE_W) * SLIDE_W, Math.ceil((x + w) / SLIDE_W) * SLIDE_W];
          g.lines.push({ axis, v: hit.t.v, from, to, strong: !!o });
        }
        return g;
      };
      if (d.kind === 'move') {
        const hx = snapBest([L0, L0 + s.w / 2, L0 + s.w], xs, tol);
        // Gaps: our left edge sits a gap right of a neighbour, or our right edge a gap left of one.
        const hxGap = snapBest([L0], gapX.filter((t) => t.photo && t.v > t.photo.x), tol) ?? snapBest([L0 + s.w], gapX.filter((t) => t.photo && t.v < t.photo.x), tol);
        const hy = snapBest([T0, T0 + s.h / 2, T0 + s.h], ys, tol);
        const hyGap = snapBest([T0], gapY.filter((t) => t.photo && t.v > t.photo.y), tol) ?? snapBest([T0 + s.h], gapY.filter((t) => t.photo && t.v < t.photo.y), tol);
        const useX = hxGap && (!hx || hxGap.d < hx.d) ? { ...hxGap, i: hxGap.t.v > hxGap.t.photo!.x ? 0 : 2 } : hx;
        const useY = hyGap && (!hy || hyGap.d < hy.d) ? { ...hyGap, i: hyGap.t.v > hyGap.t.photo!.y ? 0 : 2 } : hy;
        const x = useX ? useX.t.v - [0, s.w / 2, s.w][useX.i] - origin : L0 - origin;
        const y = useY ? useY.t.v - [0, s.h / 2, s.h][useY.i] : T0;
        onGuides(guidesFor(useX, useY, origin + x, y, s.w, s.h));
        onChange({ x: Math.round(x), y: Math.round(y) });
      } else {
        // Resize keeps the frame's shape; edges snap to neighbours, and a photo can take on a
        // neighbour's exact height or width so the two read as a pair.
        const ratio = s.w / s.h;
        let w = Math.max(120, s.w + dx);
        const R = origin + s.x + w;
        const hx = snapBest([R], xs, tol);
        const hy = snapBest([s.y + w / ratio], ys, tol);
        const same = near.map((o) => ({ o, d: Math.min(Math.abs(o.h - w / ratio), Math.abs(o.w - w)) })).sort((a, b) => a.d - b.d)[0];
        let partner: Rect | undefined;
        if (same && same.d < tol) {
          partner = same.o;
          w = Math.abs(same.o.h - w / ratio) < Math.abs(same.o.w - w) ? same.o.h * ratio : same.o.w;
        } else if (hx) w = hx.t.v - origin - s.x;
        else if (hy) w = (hy.t.v - s.y) * ratio;
        const g = partner ? { ...NO_GUIDES, partners: [partner.id!] } : guidesFor(hx, !hx ? hy : null, origin + s.x, s.y, w, w / ratio);
        onGuides(g);
        onChange({ w: Math.round(w), h: Math.round(w / ratio) });
      }
    }
  };

  const up = () => {
    drag.current = null;
    onGuides(NO_GUIDES);
  };

  const wheel = (e: React.WheelEvent) => {
    if (!editable || !selected || mode !== 'photo' || !onChange) return;
    onChange({ crop: { ...item.crop, zoom: clamp(item.crop.zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06), 1, 4) } });
  };

  const b = item.border * scale;
  return (
    <div
      className={`item ${selected ? 'sel' : ''} ${partner ? 'partner' : ''}`}
      style={{
        left: (ax - item.border) * scale,
        top: (item.y - item.border) * scale,
        width: item.w * scale + 2 * b,
        height: item.h * scale + 2 * b,
        zIndex: Math.round(z * 10) + 1,
        background: style.frame,
        padding: b,
        boxShadow: item.shadow ? `0 ${14 * scale}px ${40 * scale}px rgba(0,0,0,.45)` : undefined,
        cursor: editable ? (mode === 'photo' || item.base ? 'grab' : 'move') : undefined,
      }}
      onPointerDown={(e) => down(e)}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onWheel={wheel}
    >
      <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
        <img
          src={url}
          alt=""
          draggable={false}
          style={{ width: imgW, height: imgH, left: -sx * imgW, top: -sy * imgH, filter: filter ? `url(#${filter})` : undefined }}
        />
      </div>
      {selected && editable && mode === 'frame' && !item.base && <div className="handle" onPointerDown={(e) => down(e, 'resize')} />}
      {selected && editable && mode === 'crop' && !item.base &&
        (['l', 'r', 't', 'b'] as Edge[]).map((edge) => (
          <div key={edge} className={`crop-edge ${edge}`} onPointerDown={(e) => down(e, edge)} />
        ))}
    </div>
  );
}

interface Props {
  carousel: Carousel;
  photos: Map<string, Photo>;
  style: StyleOptions;
  scale: number;
  editable?: boolean;
  mode?: EditMode;
  guides?: boolean;
  selected?: { sectionId: string; itemId: string } | null;
  onSelect?: (s: { sectionId: string; itemId: string } | null) => void;
  onChange?: (sectionId: string, itemId: string, patch: Partial<Item>) => void;
  renderSection?: (sectionId: string, left: number, width: number, index: number) => React.ReactNode;
}

export function CarouselCanvas({ carousel, photos, style, scale, editable, mode, guides, selected, onSelect, onChange, renderSection }: Props) {
  const n = slideCount(carousel);
  const [guidesOn, setGuidesOn] = useState<Guides>(NO_GUIDES);
  // Every photo's rectangle in canvas px, for aligning to neighbours while dragging.
  const rects = useMemo(() => {
    let st = 0;
    return carousel.sections.flatMap((sec) => {
      const o = st * SLIDE_W;
      st += sec.span;
      return sec.items.filter((it) => !it.base).map((it) => ({ id: it.id, x: o + it.x, y: it.y, w: it.w, h: it.h }));
    });
  }, [carousel]);
  // Color grades, one SVG filter per distinct grade.
  const grades = useMemo(() => {
    const used = carousel.sections.flatMap((sec) => sec.items.map((it) => photos.get(it.photoId))).filter(Boolean) as Photo[];
    const tone = albumTone(used);
    const byItem = new Map<string, string>();
    const defs: { id: string; values: string }[] = [];
    const seen = new Map<string, string>();
    for (const sec of carousel.sections)
      for (const it of sec.items) {
        const p = photos.get(it.photoId);
        if (!p) continue;
        const g = gradeFor(p, style, tone, it.mono);
        if (isIdentity(g)) continue;
        const values = svgMatrix(g);
        let id = seen.get(values);
        if (!id) {
          id = `g${carousel.id.slice(-6)}${defs.length}`.replace(/[^a-z0-9]/gi, '');
          seen.set(values, id);
          defs.push({ id, values });
        }
        byItem.set(it.id, id);
      }
    return { byItem, defs };
  }, [carousel, photos, style]);
  let start = 0;
  return (
    <div className="canvas" style={{ width: n * SLIDE_W * scale, height: SLIDE_H * scale, background: backgroundOf(style, carousel) }} onPointerDown={() => onSelect?.(null)}>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <defs>
          {grades.defs.map((d) => (
            <filter key={d.id} id={d.id} colorInterpolationFilters="sRGB">
              <feColorMatrix type="matrix" values={d.values} />
            </filter>
          ))}
        </defs>
      </svg>
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
        {carousel.sections.flatMap((sec, si) => {
          const origin = start * SLIDE_W;
          start += sec.span;
          return sec.items.map((it) => {
            const p = photos.get(it.photoId);
            if (!p) return null;
            return (
              <PhotoItem
                key={it.id}
                item={it}
                ax={origin + it.x}
                photo={p}
                scale={scale}
                style={style}
                z={it.z + si * 0.01}
                editable={editable}
                mode={mode}
                selected={selected?.itemId === it.id}
                onSelect={() => onSelect?.({ sectionId: sec.id, itemId: it.id })}
                onChange={(patch) => onChange?.(sec.id, it.id, patch)}
                others={rects.filter((r) => r.id !== it.id)}
                filter={grades.byItem.get(it.id)}
                slides={n}
                onGuides={setGuidesOn}
                partner={guidesOn.partners.includes(it.id)}
              />
            );
          });
        })}
      </div>
      {guidesOn.lines.map((l) => (
        <div
          key={`${l.axis}${l.v}`}
          className={`align-guide ${l.axis === 'x' ? 'v' : 'h'} ${l.strong ? 'strong' : ''}`}
          style={
            l.axis === 'x'
              ? { left: l.v * scale, top: l.from * scale - 10, height: (l.to - l.from) * scale + 20 }
              : { top: l.v * scale, left: l.from * scale - 10, width: (l.to - l.from) * scale + 20 }
          }
        />
      ))}
      {guidesOn.gaps.map((g) => (
        <div
          key={`gap${g.axis}${g.a}`}
          className={`gap-mark ${g.axis}`}
          style={
            g.axis === 'x'
              ? { left: g.a * scale, width: (g.b - g.a) * scale, top: g.at * scale }
              : { top: g.a * scale, height: (g.b - g.a) * scale, left: g.at * scale }
          }
        />
      ))}
      {guides &&
        Array.from({ length: n }, (_, i) => (
          <div key={i}>
            {i > 0 && <div className="seam" style={{ left: i * SLIDE_W * scale }} />}
            <div className="slide-no" style={{ left: i * SLIDE_W * scale }}>
              {String(i + 1).padStart(2, '0')}
            </div>
          </div>
        ))}
      {renderSection &&
        (() => {
          let s = 0;
          return carousel.sections.map((sec, i) => {
            const left = s * SLIDE_W * scale;
            s += sec.span;
            return <div key={sec.id}>{renderSection(sec.id, left, sec.span * SLIDE_W * scale, i)}</div>;
          });
        })()}
    </div>
  );
}
