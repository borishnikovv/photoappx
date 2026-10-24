import { useMemo, useState } from 'react';
import { useStore } from '../store';
import type { Photo } from '../types';

type Filter = 'all' | 'picks' | 'out';

function Meter({ label, v }: { label: string; v?: number }) {
  if (v == null) return null;
  return (
    <>
      <span className="mono faint">{label}</span>
      <div className="meter">
        <div style={{ width: `${v * 100}%` }} />
      </div>
      <span className="mono dim">{Math.round(v * 100)}</span>
    </>
  );
}

function Detail({ p, picked }: { p: Photo; picked: boolean }) {
  const togglePick = useStore((s) => s.togglePick);
  const a = p.analysis;
  return (
    <div className="detail">
      <img src={p.thumb} alt="" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
          <div className="mono faint">
            {new Date(p.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · {p.width}×{p.height}
          </div>
        </div>
        <button className={`btn sm ${picked ? '' : 'primary'}`} onClick={() => togglePick(p.id)}>
          {picked ? 'Remove' : 'Add'}
        </button>
      </div>
      {a ? (
        <>
          <ul className="reasons">
            {a.reasons.length ? a.reasons.map((r) => <li key={r}>{r}</li>) : <li>Solid, unremarkable frame</li>}
          </ul>
          <div className="meters">
            <Meter label="Art" v={a.aesthetic} />
            <Meter label="Candid" v={a.style} />
            <Meter label="Focus" v={a.sharpness} />
            <Meter label="Light" v={a.exposure} />
            <Meter label="Color" v={a.colorfulness} />
          </div>
          <div className="palette">
            {a.palette.map((c) => (
              <span key={c} style={{ background: c }} />
            ))}
          </div>
        </>
      ) : (
        <p className="faint">Not reviewed yet.</p>
      )}
    </div>
  );
}

export function CurateView() {
  const { photos, picks, analyzing, smartMode, count, setCount, seq, setSeq, togglePick, movePick, compose, analyze, autoPick } = useStore();
  const [filter, setFilter] = useState<Filter>('all');
  const [focus, setFocus] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const byId = useStore((s) => s.byId);
  const pickIndex = useMemo(() => new Map(picks.map((id, i) => [id, i])), [picks]);
  const reviewed = photos.some((p) => p.analysis);

  const shown = photos.filter((p) =>
    filter === 'picks' ? pickIndex.has(p.id) : filter === 'out' ? p.analysis?.reject || p.analysis?.groupBest === false : true,
  );
  const sorted = filter === 'picks' ? [...shown].sort((a, b) => pickIndex.get(a.id)! - pickIndex.get(b.id)!) : shown;
  const focused = (focus && byId.get(focus)) || (picks[0] && byId.get(picks[0])) || photos[0];

  return (
    <div className="curate">
      <div>
        <div className="bar">
          <div className="seg">
            {(['all', 'picks', 'out'] as Filter[]).map((f) => (
              <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === 'all' ? `All ${photos.length}` : f === 'picks' ? `Picks ${picks.length}` : 'Cut'}
              </button>
            ))}
          </div>
          <div className="grow" />
          <div className="field">
            <span className="mono faint">Photos</span>
            <input type="range" min={3} max={30} value={count} onChange={(e) => setCount(+e.target.value)} />
            <span className="mono" style={{ width: 18 }}>
              {count}
            </span>
          </div>
          <div className="seg" title="How the picks are ordered after the opening shot">
            <button aria-pressed={seq === 'story'} onClick={() => setSeq('story')}>
              Story
            </button>
            <button aria-pressed={seq === 'color'} onClick={() => setSeq('color')}>
              Color flow
            </button>
          </div>
        </div>
        <div className="grid-wrap">
          <div className="grid">
            {sorted.map((p) => {
              const i = pickIndex.get(p.id);
              const cut = p.analysis && (p.analysis.reject || p.analysis.groupBest === false);
              return (
                <button
                  key={p.id}
                  className={`tile ${i == null && reviewed ? 'out' : ''}`}
                  aria-selected={focused?.id === p.id}
                  onClick={() => setFocus(p.id)}
                  onDoubleClick={() => togglePick(p.id)}
                >
                  <img src={p.thumb} alt={p.name} loading="lazy" />
                  {i != null && <span className="num">{i + 1}</span>}
                  {p.analysis && <span className="score">{p.analysis.score}</span>}
                  {cut && <span className="x">{p.analysis!.groupBest === false ? 'DUP' : 'CUT'}</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <aside className="side">
        {analyzing ? (
          <div>
            <h3>{analyzing.stage}</h3>
            <p className="mono faint" style={{ margin: '6px 0 10px' }}>
              {analyzing.modelProgress != null && !analyzing.done
                ? `Model ${Math.round(analyzing.modelProgress)}% · first run only`
                : `${analyzing.done} / ${analyzing.total}`}
            </p>
            <div className="progress">
              <div
                style={{
                  width: `${analyzing.modelProgress != null && !analyzing.done ? analyzing.modelProgress : (analyzing.done / Math.max(1, analyzing.total)) * 100}%`,
                }}
              />
            </div>
          </div>
        ) : (
          <div>
            <h3>{reviewed ? `${picks.length} picks` : 'Not reviewed'}</h3>
            <p className="dim" style={{ margin: '6px 0 12px', fontSize: 13 }}>
              {reviewed
                ? smartMode === false
                  ? 'Basic mode: the art-director model could not load, so picks use focus, light, faces and duplicates only.'
                  : 'Opening shot first. Drag to reorder, double-click a tile to add or remove.'
                : 'Review the folder to get picks.'}
            </p>
            {reviewed ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" disabled={picks.length < 1} onClick={() => compose(true)}>
                  Compose
                </button>
                <button className="btn" onClick={autoPick}>
                  Re-pick
                </button>
              </div>
            ) : (
              <button className="btn primary" onClick={analyze}>
                Review photos
              </button>
            )}
          </div>
        )}

        {picks.length > 0 && (
          <div className="picks" onDragOver={(e) => e.preventDefault()}>
            {picks.map((id, i) => (
              <img
                key={id}
                src={byId.get(id)?.thumb}
                alt=""
                draggable
                className={drag === id ? 'dragging' : ''}
                onDragStart={() => setDrag(id)}
                onDragEnd={() => setDrag(null)}
                onDragEnter={() => drag && drag !== id && movePick(drag, i)}
                onClick={() => setFocus(id)}
              />
            ))}
          </div>
        )}

        {focused && <Detail p={focused} picked={pickIndex.has(focused.id)} />}
      </aside>
      {reviewed && !analyzing && (
        <div className="mobile-cta">
          <span className="mono dim">{picks.length} picks</span>
          <span className="grow" />
          <button className="btn sm" onClick={autoPick}>
            Re-pick
          </button>
          <button className="btn sm primary" disabled={!picks.length} onClick={() => compose(true)}>
            Compose
          </button>
        </div>
      )}
    </div>
  );
}
