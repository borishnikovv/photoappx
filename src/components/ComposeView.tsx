import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { CarouselCanvas, type EditMode } from './CarouselCanvas';
import { templateById } from '../lib/layout';
import { SLIDE_H, SLIDE_W, slideCount } from '../lib/geometry';
import type { Family } from '../types';

const FRAMES = ['#f4f1ea', '#ffffff', '#0d0d0d'];
const FAMILIES: { id: Family; label: string }[] = [
  { id: 'mosaic', label: 'Mosaic' },
  { id: 'spread', label: 'Spreads' },
  { id: 'pano', label: 'Panoramas' },
  { id: 'layered', label: 'Layered' },
  { id: 'gallery', label: 'Gallery' },
];

function useStageScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight - 110;
      setScale(Math.max(0.12, Math.min(0.55, h / SLIDE_H)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, scale };
}

function Preview({ onClose }: { onClose: () => void }) {
  const { carousels, active, byId, style } = useStore();
  const c = carousels[active];
  const n = slideCount(c);
  const vp = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(360);
  const [i, setI] = useState(0);
  useLayoutEffect(() => setW(vp.current?.clientWidth ?? 360), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  const scale = w / SLIDE_W;
  return (
    <div className="modal" onClick={onClose}>
      <div className="phone" onClick={(e) => e.stopPropagation()}>
        <div className="ig-head">
          <i /> yourname
        </div>
        <div
          className="viewport"
          ref={vp}
          onScroll={(e) => setI(Math.round(e.currentTarget.scrollLeft / w))}
          style={{ height: SLIDE_H * scale }}
        >
          <div style={{ position: 'relative', width: n * w }}>
            {Array.from({ length: n }, (_, k) => (
              <div key={k} className="snap" style={{ left: k * w, width: w }} />
            ))}
            <CarouselCanvas carousel={c} photos={byId} style={style} scale={scale} />
          </div>
        </div>
        <div className="dots">
          {Array.from({ length: n }, (_, k) => (
            <span key={k} className={k === i ? 'on' : ''} />
          ))}
        </div>
      </div>
      <div className="mono faint" style={{ position: 'absolute', bottom: 24 }}>
        Swipe · Esc to close
      </div>
    </div>
  );
}

export function ComposeView() {
  const s = useStore();
  const { carousels, active, setActive, byId, style, setStyle, selected, select, updateItem, picks, photos } = s;
  const c = carousels[active];
  const { ref, scale: fit } = useStageScale();
  const [zoom, setZoom] = useState(() => (innerWidth < 860 ? 1 : 0.7));
  const scale = fit * zoom;
  const [mode, setMode] = useState<EditMode>('frame');
  const [preview, setPreview] = useState(false);

  const sel = useMemo(() => {
    if (!selected || !c) return null;
    const sec = c.sections.find((x) => x.id === selected.sectionId);
    const it = sec?.items.find((x) => x.id === selected.itemId);
    return sec && it ? { sec, it } : null;
  }, [selected, c]);

  const used = useMemo(() => new Set(c?.sections.flatMap((x) => x.items.map((i) => i.photoId))), [c]);
  const tray = useMemo(() => {
    const extra = photos
      .filter((p) => !picks.includes(p.id) && p.analysis && !p.analysis.reject)
      .sort((a, b) => b.analysis!.score - a.analysis!.score)
      .slice(0, 24);
    return [...picks.map((id) => byId.get(id)!), ...extra];
  }, [photos, picks, byId]);

  if (!c) return <div className="empty">Pick some photos first.</div>;

  const toggleFamily = (f: Family) => {
    const families = { ...style.families, [f]: !style.families[f] };
    setStyle({ families });
  };

  return (
    <div className="compose">
      <div className="bar">
        <div className="seg">
          {carousels.map((v, i) => (
            <button key={v.id} aria-pressed={i === active} onClick={() => setActive(i)}>
              {v.name}
            </button>
          ))}
        </div>
        <button className="btn sm" disabled={s.arranging} onClick={() => s.arrange(true)} title="New layouts with the same photos">
          {s.arranging ? 'Arranging…' : 'Regenerate'}
        </button>
        <div className="sep" />
        {FAMILIES.map((f) => (
          <button key={f.id} className="chip" aria-pressed={style.families[f.id]} onClick={() => toggleFamily(f.id)}>
            <span className="dot" />
            {f.label}
          </button>
        ))}
        <div className="sep" />
        <div className="seg" title="How photos laid on top of others look">
          <button aria-pressed={style.overlay === 'clean'} onClick={() => setStyle({ overlay: 'clean' })}>
            Clean
          </button>
          <button aria-pressed={style.overlay === 'framed'} onClick={() => setStyle({ overlay: 'framed' })}>
            Framed
          </button>
        </div>
        {style.overlay === 'framed' && (
          <div className="field">
            {FRAMES.map((b) => (
              <button key={b} className="swatch" style={{ background: b }} aria-pressed={style.frame === b} onClick={() => setStyle({ frame: b })} />
            ))}
          </div>
        )}
        <div className="grow" />
        <div className="field">
          <span className="mono faint">View</span>
          <input type="range" min={0.3} max={1} step={0.01} value={zoom} onChange={(e) => setZoom(+e.target.value)} style={{ width: 80 }} />
        </div>
        <div className="field" title="Instagram allows up to 20">
          <span className="mono faint">Slides</span>
          <input type="range" min={4} max={20} value={style.maxSlides} onChange={(e) => setStyle({ maxSlides: +e.target.value })} style={{ width: 80 }} />
          <span className="mono" style={{ width: 52 }}>
            {slideCount(c)}/{style.maxSlides}
          </span>
        </div>
        <button className="btn sm" onClick={() => setPreview(true)}>
          Preview
        </button>
        <button className="btn sm primary" onClick={() => s.setStep('export')}>
          Export
        </button>
      </div>

      <div className="stage" ref={ref} onPointerDown={() => select(null)}>
        <CarouselCanvas
          carousel={c}
          photos={byId}
          style={style}
          scale={scale}
          editable
          guides
          mode={mode}
          selected={selected}
          onSelect={select}
          onChange={updateItem}
          renderSection={(id, left, width, i) => {
            const sec = c.sections.find((x) => x.id === id)!;
            const on = selected?.sectionId === id;
            return (
              <>
                <div className="sec-bracket" style={{ left: left + 6, width: width - 12, bottom: -14 }} />
                <div className={`sec-tools ${on ? 'on' : ''}`} style={{ left, width, bottom: -46 }} onPointerDown={(e) => e.stopPropagation()}>
                  <button className="btn ghost icon sm" title="Move earlier" disabled={i === 0} onClick={() => s.moveSection(id, -1)}>
                    ‹
                  </button>
                  {width > 170 && <span className="name">{templateById(sec.template).label}</span>}
                  <button className="btn ghost icon sm" title="Move later" disabled={i === c.sections.length - 1} onClick={() => s.moveSection(id, 1)}>
                    ›
                  </button>
                  <button className="btn ghost icon sm" title="Try another layout" onClick={() => s.shuffleSection(id)}>
                    ↻
                  </button>
                  <button className="btn ghost icon sm" title="Remove" onClick={() => s.removeSection(id)}>
                    ×
                  </button>
                </div>
              </>
            );
          }}
        />
      </div>

      <div className="dock">
        {sel ? (
          <>
            {sel.it.base ? (
              <span className="mono faint">Backdrop · drag to pan</span>
            ) : (
              <div className="seg">
                <button aria-pressed={mode === 'frame'} onClick={() => setMode('frame')}>
                  Move
                </button>
                <button aria-pressed={mode === 'photo'} onClick={() => setMode('photo')}>
                  Pan
                </button>
                <button aria-pressed={mode === 'crop'} onClick={() => setMode('crop')}>
                  Crop
                </button>
              </div>
            )}
            <div className="field">
              <span className="mono faint">Zoom</span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={sel.it.crop.zoom}
                onChange={(e) => updateItem(sel.sec.id, sel.it.id, { crop: { ...sel.it.crop, zoom: +e.target.value } })}
              />
            </div>
            {!sel.it.base && (
              <>
                <button
                  className="chip"
                  aria-pressed={sel.it.border > 0}
                  onClick={() => updateItem(sel.sec.id, sel.it.id, { border: sel.it.border ? 0 : 12 })}
                >
                  <span className="dot" /> Border
                </button>
                <button className="chip" aria-pressed={sel.it.shadow} onClick={() => updateItem(sel.sec.id, sel.it.id, { shadow: !sel.it.shadow })}>
                  <span className="dot" /> Shadow
                </button>
                <button className="btn sm ghost" onClick={() => s.restack(sel.sec.id, sel.it.id, 'front')}>
                  Forward
                </button>
                <button className="btn sm ghost" onClick={() => s.restack(sel.sec.id, sel.it.id, 'back')}>
                  Back
                </button>
              </>
            )}
            <button className="btn sm ghost" onClick={() => s.removeItem(sel.sec.id, sel.it.id)}>
              Remove
            </button>
            <div className="sep" />
            <span className="mono faint">Swap with</span>
          </>
        ) : (
          <span className="mono faint">Tap a photo to edit · tap below to add a slide</span>
        )}
        <div className="tray">
          {tray.map((p) => (
            <button
              key={p.id}
              className={used.has(p.id) ? 'used' : ''}
              title={p.name}
              onClick={() => (sel ? s.swapPhoto(sel.sec.id, sel.it.id, p.id) : s.appendPhoto(p.id))}
            >
              <img src={p.thumb} alt="" />
            </button>
          ))}
        </div>
      </div>
      {preview && <Preview onClose={() => setPreview(false)} />}
    </div>
  );
}
