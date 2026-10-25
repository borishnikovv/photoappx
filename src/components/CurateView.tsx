import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import type { Photo } from '../types';
import { AskModal } from './AskModal';
import { Thumbs } from './Thumbs';
import { votePhoto } from '../lib/taste';
import { previewLevel } from '../lib/straighten';
import { clipProblem, tiltVerdict } from '../lib/curate';

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
  const setStraight = useStore((s) => s.setStraight);
  const [busy, setBusy] = useState(false);
  const a = p.analysis;
  const level = async (on: boolean | { tilt: number; keystone: number }) => {
    setBusy(true);
    await setStraight(p.id, on);
    setBusy(false);
    setEdit(null);
  };
  // Manual leveling: rotation (degrees clockwise) and skew, previewed exactly on the original.
  const applied = { turn: p.straightened != null ? -p.straightened : 0, skew: p.keystone ? -p.keystone : 0 };
  const [edit, setEdit] = useState<{ turn: number; skew: number } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const base = p.original ? { ...p, ...p.original } : p;
  useEffect(() => {
    if (!edit) return setPreview(null);
    let live = true;
    const t = setTimeout(() => {
      previewLevel(base.thumb, -edit.turn, -edit.skew).then((u) => (live ? setPreview(u) : URL.revokeObjectURL(u)));
    }, 90);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [edit, base.thumb]);
  const v = edit ?? applied;
  const slider = (label: string, key: 'turn' | 'skew', title: string) => (
    <div className="field" style={{ marginTop: 8 }} title={title}>
      <span className="mono faint" style={{ width: 38 }}>
        {label}
      </span>
      <input
        type="range"
        min={-15}
        max={15}
        step={0.1}
        value={v[key]}
        onChange={(e) => setEdit({ ...v, [key]: +e.target.value })}
        style={{ flex: 1, width: 'auto' }}
      />
      <span className="mono" style={{ width: 44, textAlign: 'right' }}>
        {v[key].toFixed(1)}°
      </span>
    </div>
  );
  return (
    <div className="detail">
      {edit ? (
        <div style={{ position: 'relative', background: 'var(--bg-1)', borderRadius: 6, overflow: 'hidden', display: 'flex', justifyContent: 'center' }}>
          <div style={{ position: 'relative' }}>
            <img src={preview ?? base.thumb} alt="" style={{ maxHeight: 300, maxWidth: '100%' }} />
            <div className="level-grid" />
          </div>
        </div>
      ) : (
        <img src={p.thumb} alt="" />
      )}
      {slider('Level', 'turn', 'Rotate to level the horizon')}
      {slider('Skew', 'skew', 'Straighten leaning verticals (buildings, door frames) from shooting up or down')}
      {edit && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button className="btn sm primary" disabled={busy} onClick={() => level({ tilt: -edit.turn, keystone: -edit.skew })}>
            {busy ? '…' : 'Apply'}
          </button>
          <button className="btn sm ghost" disabled={busy} onClick={() => setEdit(null)}>
            Cancel
          </button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
          <div className="mono faint">
            {new Date(p.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · {p.width}×{p.height}
          </div>
        </div>
        {a && <Thumbs id={p.id} what="photos" onVote={(v) => votePhoto(p, v)} />}
        <button className={`btn sm ${picked ? '' : 'primary'}`} onClick={() => togglePick(p.id)}>
          {picked ? 'Remove' : 'Add'}
        </button>
      </div>
      {a ? (
        <>
          {(p.straightened != null || tiltVerdict(a)) && (
            <div className="ask-banner" style={{ marginTop: 12 }}>
              <span style={{ flex: 1 }}>
                {p.straightened != null ? `Straightened ${Math.abs(p.straightened).toFixed(1)}°${p.keystone ? `, skew ${Math.abs(p.keystone).toFixed(1)}°` : ''}` : `Looks ${Math.abs(a.tilt!).toFixed(1)}° off level`}
              </span>
              <button className="btn sm" disabled={busy} onClick={() => level(p.straightened == null)}>
                {p.straightened != null ? 'Undo' : 'Straighten'}
              </button>
            </div>
          )}
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
  const { arrange, arranging, photos, picks, analyzing, smartMode, count, setCount, seq, setSeq, togglePick, movePick, analyze, autoPick, decisions, askOpen, setAskOpen, retryModel } =
    useStore();
  const [composeAfter, setComposeAfter] = useState(false);
  // Open questions get answered before composing; the user can still defer them.
  const goCompose = () => {
    if (decisions.length) {
      setComposeAfter(true);
      setAskOpen(true);
    } else arrange(true);
  };
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
            <input type="range" min={3} max={60} value={count} onChange={(e) => setCount(+e.target.value)} />
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
                ? picks.length < count
                    ? `Only ${picks.length} distinct enough: I skipped near-repeats of the same scene. Opening shot first; drag to reorder.`
                    : 'One per moment across the whole album, opening shot first. Drag to reorder, double-click a tile to add or remove.'
                : 'Review the folder to get picks.'}
            </p>
            {reviewed && smartMode != null && (
              <div className={`model-status ${smartMode ? 'on' : 'off'}`}>
                <span className="dot" />
                <span style={{ flex: 1 }}>
                  {smartMode ? (
                    'Art director on'
                  ) : (
                    <>
                      Basic mode · {clipProblem || "The model couldn't load"}
                      <span className="faint"> — picks use focus, light, faces and duplicates only.</span>
                    </>
                  )}
                </span>
                {!smartMode && (
                  <button className="btn sm" onClick={retryModel}>
                    Retry
                  </button>
                )}
              </div>
            )}
            {reviewed && decisions.length > 0 && (
              <div className="ask-banner" style={{ marginBottom: 12 }}>
                <span style={{ flex: 1 }}>
                  {decisions.length} {decisions.length === 1 ? 'call' : 'calls'} I'd like you to make
                </span>
                <button className="btn sm primary" onClick={() => setAskOpen(true)}>
                  Choose
                </button>
              </div>
            )}
            {reviewed ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" disabled={picks.length < 1 || arranging} onClick={goCompose}>
                  {arranging ? 'Arranging…' : 'Compose'}
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

        {focused && <Detail key={focused.id} p={focused} picked={pickIndex.has(focused.id)} />}
      </aside>
      {reviewed && !analyzing && (
        <div className="mobile-cta">
          <span className="mono dim">{picks.length} picks</span>
          <span className="grow" />
          <button className="btn sm" onClick={autoPick}>
            Re-pick
          </button>
          <button className="btn sm primary" disabled={!picks.length || arranging} onClick={goCompose}>
            {arranging ? 'Arranging…' : 'Compose'}
          </button>
        </div>
      )}
      {askOpen && (
        <AskModal
          onDone={() => {
            setAskOpen(false);
            if (composeAfter) {
              setComposeAfter(false);
              arrange(true);
            }
          }}
        />
      )}
    </div>
  );
}
