import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { CarouselCanvas, type EditMode } from './CarouselCanvas';
import { compatibleTemplates, rebuildSection, scoreSection, templateById } from '../lib/layout';
import { SLIDE_H, SLIDE_W, slideCount } from '../lib/geometry';
import type { Family, Section } from '../types';
import { LOOK_NAMES, type Look } from '../lib/grade';
import { Thumbs } from './Thumbs';
import { voteLayout } from '../lib/taste';
import { GRID_W, GRID_X, firstSlideCheck } from '../lib/gridcheck';

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

/** How the post first appears: alone in the feed, and cropped to 3:4 in the profile grid. */
function GridCheck({ onClose }: { onClose: () => void }) {
  const { carousels, active, byId, style, picks } = useStore();
  const c = carousels[active];
  const issues = useMemo(() => firstSlideCheck(c, byId), [c, byId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  const feedW = Math.min(300, innerWidth - 64), feed = feedW / SLIDE_W;
  const cellW = Math.min(110, (innerWidth - 80) / 3), cell = cellW / GRID_W;
  // The rest of the grid: older posts, suggested by other photos, so the cover is seen in context.
  const others = picks.slice(-8).map((id) => byId.get(id)?.thumb).filter(Boolean) as string[];
  return (
    <div className="modal" onClick={onClose}>
      <div className="gridcheck" onClick={(e) => e.stopPropagation()}>
        <div>
          <div className="mono faint" style={{ marginBottom: 8 }}>In the feed</div>
          <div style={{ width: feedW, height: SLIDE_H * feed, overflow: 'hidden', position: 'relative', borderRadius: 4 }}>
            <CarouselCanvas carousel={c} photos={byId} style={style} scale={feed} />
          </div>
        </div>
        <div>
          <div className="mono faint" style={{ marginBottom: 8 }}>On your profile</div>
          <div className="pgrid" style={{ gridTemplateColumns: `repeat(3, ${cellW}px)` }}>
            <div style={{ width: cellW, height: SLIDE_H * cell, overflow: 'hidden', position: 'relative' }}>
              <div style={{ position: 'absolute', left: -GRID_X * cell, top: 0 }}>
                <CarouselCanvas carousel={c} photos={byId} style={style} scale={cell} />
              </div>
            </div>
            {Array.from({ length: 8 }, (_, k) =>
              others[k] ? <img key={k} src={others[k]} alt="" style={{ height: SLIDE_H * cell }} /> : <span key={k} style={{ height: SLIDE_H * cell }} />,
            )}
          </div>
          <div className="gc-notes">
            {issues.length ? (
              issues.map((i) => (
                <p key={i.text}>
                  <span className="warn-dot" /> {i.text}
                </p>
              ))
            ) : (
              <p>
                <span className="ok-dot" /> The cover holds up on its own and in the grid.
              </p>
            )}
            {issues.length > 0 && <p className="faint">Try ↻ on the first layout, or move the photo with Pan.</p>}
          </div>
        </div>
      </div>
      <div className="mono faint" style={{ position: 'absolute', bottom: 24 }}>
        Esc to close
      </div>
    </div>
  );
}

/** Named snapshots: save where you are, try something bolder, come back. */
function Drafts() {
  const { drafts, saveDraft, restoreDraft, deleteDraft } = useStore();
  const [open, setOpen] = useState(false);
  return (
    <div className="pop-wrap">
      <button className="btn sm ghost" aria-expanded={open} onClick={() => setOpen(!open)} title="Save and switch between versions">
        Drafts{drafts.length ? ` · ${drafts.length}` : ''}
      </button>
      {open && (
        <div className="pop" onPointerDown={(e) => e.stopPropagation()}>
          <button className="btn sm" style={{ width: '100%' }} onClick={saveDraft}>
            Save as draft
          </button>
          {drafts.length ? (
            drafts.map((d) => (
              <div key={d.id} className="pop-row">
                <button className="pop-main" onClick={() => (restoreDraft(d.id), setOpen(false))} title="Go back to this draft">
                  {d.name}
                  <span className="mono faint">{new Date(d.savedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                </button>
                <button className="btn ghost sm icon" aria-label={`Delete ${d.name}`} onClick={() => deleteDraft(d.id)}>
                  ×
                </button>
              </div>
            ))
          ) : (
            <p className="faint" style={{ margin: '8px 2px 0', fontSize: 12 }}>
              Up to 5. Your work also saves automatically.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Scored alternatives for one section: the same photos in other layouts, best first. */
function Alternatives({ sectionId, onClose }: { sectionId: string; onClose: () => void }) {
  const { carousels, active, byId, style, replaceSection } = useStore();
  const c = carousels[active];
  const sec = c.sections.find((x) => x.id === sectionId);
  const options = useMemo(() => {
    if (!sec) return [];
    const ps = sec.items.filter((i) => !i.bridge).map((i) => byId.get(i.photoId)!).filter(Boolean);
    const built: { sec: Section; score: number }[] = [];
    for (const t of compatibleTemplates(ps, style))
      for (let k = 0; k < (t.rigid ? 1 : 2); k++) {
        const alt = rebuildSection({ ...sec, items: [] }, t, ps, style, Math.floor(Math.random() * 1e9));
        built.push({ sec: alt, score: scoreSection(alt, byId).score });
      }
    // Best per layout, then the best four overall.
    const best = new Map<string, { sec: Section; score: number }>();
    for (const b of built) if (!best.has(b.sec.template) || best.get(b.sec.template)!.score < b.score) best.set(b.sec.template, b);
    return [...best.values()].filter((b) => b.sec.template !== sec.template).sort((a, b) => b.score - a.score).slice(0, 4);
  }, [sec, byId, style]);
  if (!sec) return null;
  const h = 150, scale = h / SLIDE_H;
  return (
    <div className="alts" onPointerDown={(e) => e.stopPropagation()}>
      <div className="alts-head">
        <span className="mono faint">Other layouts for these photos</span>
        <button className="btn ghost sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="alts-row">
        {options.length ? (
          options.map((o) => (
            <button key={o.sec.id} className="alt" onClick={() => (replaceSection(sectionId, o.sec), onClose())}>
              <div style={{ pointerEvents: 'none' }}>
                <CarouselCanvas carousel={{ ...c, sections: [o.sec] }} photos={byId} style={style} scale={scale} />
              </div>
              <span className="mono">
                {templateById(o.sec.template).label} · {Math.round(o.score * 100)}
              </span>
            </button>
          ))
        ) : (
          <span className="faint">No other layouts fit these photos.</span>
        )}
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
  const [grid, setGrid] = useState(false);
  const coverIssues = useMemo(() => (c ? firstSlideCheck(c, byId).length : 0), [c, byId]);
  const [alts, setAlts] = useState<string | null>(null);
  // "Swap with…": the next photo tapped trades places with the selected one.
  const [swapFrom, setSwapFrom] = useState<{ sectionId: string; itemId: string } | null>(null);
  const onSelect = (next: { sectionId: string; itemId: string } | null) => {
    if (swapFrom && next && next.itemId !== swapFrom.itemId) {
      s.swapItems(swapFrom, next);
      setSwapFrom(null);
      return;
    }
    if (!next) setSwapFrom(null);
    select(next);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text') return;
      e.preventDefault();
      if (e.shiftKey) useStore.getState().redo();
      else useStore.getState().undo();
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);

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
        <button className="btn sm ghost icon" title="Undo (Ctrl/⌘+Z)" disabled={!s.past.length} onClick={s.undo}>
          ↶
        </button>
        <button className="btn sm ghost icon" title="Redo (Shift+Ctrl/⌘+Z)" disabled={!s.future.length} onClick={s.redo}>
          ↷
        </button>
        <Drafts />
        <div className="sep" />
        {FAMILIES.map((f) => (
          <button key={f.id} className="chip" aria-pressed={style.families[f.id]} onClick={() => toggleFamily(f.id)}>
            <span className="dot" />
            {f.label}
          </button>
        ))}
        <div className="sep" />
        <div className="field" title="One color look across the whole carousel">
          <span className="mono faint">Look</span>
          <select className="select" value={style.look ?? 'natural'} onChange={(e) => setStyle({ look: e.target.value as Look })}>
            {LOOK_NAMES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <button className="chip" aria-pressed={style.matchTones !== false} title="Even out color casts and brightness between photos" onClick={() => setStyle({ matchTones: style.matchTones === false })}>
          <span className="dot" /> Match tones
        </button>
        <button className="chip" aria-pressed={!!style.bwAccents} title="Turn some frames black-and-white for contrast" onClick={() => setStyle({ bwAccents: !style.bwAccents })}>
          <span className="dot" /> B&W accents
        </button>
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
        <button className="btn sm" onClick={() => setGrid(true)} title="How the first slide looks in the feed and on your profile grid">
          Cover{coverIssues ? <span className="badge">{coverIssues}</span> : null}
        </button>
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
          onSelect={onSelect}
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
                  <button className="btn ghost sm" title="See other layouts for these photos" onClick={() => setAlts(id)}>
                    Options
                  </button>
                  <button className={`btn ghost sm ${sec.pinned ? 'pinned' : ''}`} title="Keep this layout when regenerating" onClick={() => s.togglePin(id)}>
                    {sec.pinned ? 'Pinned' : 'Pin'}
                  </button>
                  <Thumbs id={id} what="layouts" onVote={(v) => voteLayout(id, sec.template, templateById(sec.template).family, v)} />
                  <button className="btn ghost icon sm" title="Remove" onClick={() => s.removeSection(id)}>
                    ×
                  </button>
                </div>
              </>
            );
          }}
        />
      </div>

      {alts && <Alternatives sectionId={alts} onClose={() => setAlts(null)} />}
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
            <button className="chip" aria-pressed={!!sel.it.mono} onClick={() => updateItem(sel.sec.id, sel.it.id, { mono: !sel.it.mono })}>
              <span className="dot" /> B&W
            </button>
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
            <button
              className={`btn sm ${swapFrom ? 'primary' : 'ghost'}`}
              title="Then tap any other photo, in any layout, to trade places"
              onClick={() => setSwapFrom(swapFrom ? null : { sectionId: sel.sec.id, itemId: sel.it.id })}
            >
              {swapFrom ? 'Tap a photo…' : 'Swap with…'}
            </button>
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
      {grid && <GridCheck onClose={() => setGrid(false)} />}
    </div>
  );
}
