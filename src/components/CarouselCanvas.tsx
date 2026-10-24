import { useEffect, useRef, useState } from 'react';
import type { Carousel, Item, Photo, StyleOptions } from '../types';
import { SLIDE_H, SLIDE_W, clamp, slideCount, sourceRect } from '../lib/geometry';
import { previewUrl } from '../lib/importer';

export type EditMode = 'frame' | 'photo';

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
}

/** Snaps the first of an item's edges/center that lands near a target (slide edges, centers, margins). */
function snapAny(vs: number[], targets: number[], tol: number) {
  for (let i = 0; i < vs.length; i++) for (const t of targets) if (Math.abs(vs[i] - t) < tol) return { i, t };
  return null;
}

function PhotoItem({ item, ax, photo, scale, style, z, selected, editable, mode, onSelect, onChange }: ItemProps) {
  const url = usePreview(photo);
  const drag = useRef<{ x: number; y: number; start: Item; kind: 'move' | 'pan' | 'resize' } | null>(null);
  const { sx, sy, sw, sh } = sourceRect(photo, item);
  const imgW = (item.w / sw) * scale;
  const imgH = (item.h / sh) * scale;

  const down = (e: React.PointerEvent, kind?: 'resize') => {
    if (!editable) return;
    e.stopPropagation();
    onSelect?.();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: item, kind: kind ?? (mode === 'photo' ? 'pan' : 'move') };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !onChange) return;
    const dx = (e.clientX - d.x) / scale;
    const dy = (e.clientY - d.y) / scale;
    const s = d.start;
    const tol = 14 / scale;
    if (d.kind === 'pan') {
      // Dragging right reveals more of the photo's left side.
      const fx = clamp(s.crop.fx - (dx / s.w) * sw, sw / 2, 1 - sw / 2);
      const fy = clamp(s.crop.fy - (dy / s.h) * sh, sh / 2, 1 - sh / 2);
      onChange({ crop: { ...s.crop, fx, fy } });
    } else if (d.kind === 'move') {
      const origin = ax - item.x;
      const xs: number[] = [];
      for (let k = 0; k <= 20; k++) xs.push(k * SLIDE_W, k * SLIDE_W + SLIDE_W / 2, k * SLIDE_W + 100, k * SLIDE_W - 100);
      const ys = [0, SLIDE_H, SLIDE_H / 2, 120, SLIDE_H - 120];
      const L = origin + s.x + dx;
      const T = s.y + dy;
      const hx = snapAny([L, L + s.w / 2, L + s.w], xs, tol);
      const hy = snapAny([T, T + s.h / 2, T + s.h], ys, tol);
      const x = hx ? hx.t - [0, s.w / 2, s.w][hx.i] - origin : L - origin;
      const y = hy ? hy.t - [0, s.h / 2, s.h][hy.i] : T;
      onChange({ x: Math.round(x), y: Math.round(y) });
    } else {
      const ratio = s.w / s.h;
      const w = Math.max(120, s.w + dx);
      onChange({ w: Math.round(w), h: Math.round(w / ratio) });
    }
  };

  const up = () => (drag.current = null);

  const wheel = (e: React.WheelEvent) => {
    if (!editable || !selected || mode !== 'photo' || !onChange) return;
    onChange({ crop: { ...item.crop, zoom: clamp(item.crop.zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06), 1, 4) } });
  };

  const b = item.border * scale;
  return (
    <div
      className={`item ${selected ? 'sel' : ''}`}
      style={{
        left: (ax - item.border) * scale,
        top: (item.y - item.border) * scale,
        width: item.w * scale + 2 * b,
        height: item.h * scale + 2 * b,
        zIndex: Math.round(z * 10) + 1,
        background: style.frame,
        padding: b,
        boxShadow: item.shadow ? `0 ${14 * scale}px ${40 * scale}px rgba(0,0,0,.45)` : undefined,
        cursor: editable ? (mode === 'photo' ? 'grab' : 'move') : undefined,
      }}
      onPointerDown={(e) => down(e)}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onWheel={wheel}
    >
      <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
        <img src={url} alt="" draggable={false} style={{ width: imgW, height: imgH, left: -sx * imgW, top: -sy * imgH }} />
      </div>
      {selected && editable && mode === 'frame' && <div className="handle" onPointerDown={(e) => down(e, 'resize')} />}
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
  let start = 0;
  return (
    <div className="canvas" style={{ width: n * SLIDE_W * scale, height: SLIDE_H * scale, background: style.bg }} onPointerDown={() => onSelect?.(null)}>
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
              />
            );
          });
        })}
      </div>
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
