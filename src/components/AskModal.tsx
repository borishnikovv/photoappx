import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { innerScale, previewLevel } from '../lib/straighten';
import type { Photo } from '../types';

/** The thumbnail rotated and cropped the way straightening would, as a cheap preview. */
export function Leveled({ p, angle }: { p: Photo; angle: number }) {
  const rad = (-angle * Math.PI) / 180;
  const s = innerScale(p.width, p.height, rad);
  return (
    <div style={{ aspectRatio: `${p.width} / ${p.height}`, overflow: 'hidden', borderRadius: 4, background: 'var(--bg-2)' }}>
      <img src={p.thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `rotate(${-angle}deg) scale(${1 / s})` }} />
    </div>
  );
}

/** Exact preview (tilt and skew) when skew is involved, which a CSS rotation can't show. */
function Fixed({ p, angle, keystone }: { p: Photo; angle: number; keystone?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!keystone) return;
    let live = true;
    previewLevel(p.thumb, angle, keystone).then((u) => (live ? setUrl(u) : URL.revokeObjectURL(u)));
    return () => {
      live = false;
    };
  }, [p.thumb, angle, keystone]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  if (!keystone) return <Leveled p={p} angle={angle} />;
  return url ? <img src={url} alt="" /> : <img src={p.thumb} alt="" style={{ opacity: 0.4 }} />;
}

/** What a fix does, in a few words. */
const fixLabel = (angle: number, keystone?: number) =>
  [Math.abs(angle) >= 0.05 && `Level ${Math.abs(angle).toFixed(1)}°`, keystone && `skew ${Math.abs(keystone).toFixed(1)}°`].filter(Boolean).join(' · ') || 'Straighten';

export function AskModal({ onDone }: { onDone: () => void }) {
  const { decisions, byId, resolve, setAskOpen, answered, undoAnswer } = useStore();
  const [total] = useState(decisions.length);
  // Answers given in this sitting can be taken back one at a time.
  const [startedAt] = useState(answered.length);
  const canGoBack = answered.length > startedAt;
  const back = (
    <button className="btn ghost sm" disabled={!canGoBack} onClick={undoAnswer} title="Undo the last choice">
      ← Back
    </button>
  );
  const [busy, setBusy] = useState(false);
  // Similar-shot questions one at a time, then every tilt question together on one screen.
  // (After "Back", the restored question comes first.)
  const d = decisions[0]?.kind === 'pick' ? decisions[0] : decisions.find((x) => x.kind === 'pick') ?? decisions[0];
  const tilts = decisions.filter((x): x is Extract<typeof x, { kind: 'straighten' }> => x.kind === 'straighten');
  // Each tilt question: straighten (default), keep as shot, or leave the photo out.
  const [state, setState] = useState<Map<string, 'fix' | 'keep' | 'skip'>>(new Map());
  // Nothing is straightened unless chosen: these are the uncertain ones (the clear horizons were
  // already leveled), so the safe default is the photo as shot.
  const stateOf = (id: string) => state.get(id) ?? 'keep';

  useEffect(() => {
    if (!d) onDone();
  }, [d, onDone]);
  if (!d) return null;

  const choose = async (c: string | boolean) => {
    setBusy(true);
    await resolve(d.id, c);
    setBusy(false);
  };
  const skipAll = async () => {
    for (const x of useStore.getState().decisions) await resolve(x.id, x.kind === 'pick' ? x.suggested : false);
  };
  const step = total - decisions.length + 1;
  const applyTilts = async () => {
    setBusy(true);
    for (const t of tilts) {
      const v = stateOf(t.id);
      await resolve(t.id, v === 'skip' ? 'skip' : v === 'fix');
    }
    setBusy(false);
  };

  return (
    <div className="modal ask">
      <div className="ask-card">
        <div className="mono faint">
          Help me choose · {step} of {total}
        </div>
        {d.kind === 'pick' ? (
          <>
            <h2>These are nearly tied. Which one?</h2>
            <p className="dim">Similar shots scored within a few points. Tap the one to keep, or skip them all.</p>
            <div className={`ask-options n${d.options.length}`}>
              {d.options.map((id) => {
                const p = byId.get(id)!;
                return (
                  <button key={id} disabled={busy} onClick={() => choose(id)}>
                    <img src={p.thumb} alt="" />
                    <span className="mono">
                      {p.analysis?.score}
                      {id === d.suggested ? ' · my pick' : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : tilts.length > 1 ? (
          <>
            <h2>Straighten these?</h2>
            <p className="dim">
              These might be off level, but I'm not sure. Each shows the straightened version: tap the ones that look better straightened, or skip a photo to leave it out.
            </p>
            <div className="ask-options n3">
              {tilts.map((t) => {
                const p = byId.get(t.photoId)!;
                const v = stateOf(t.id);
                return (
                  <div key={t.id} className={`tilt-opt ${v}`}>
                    <button
                      disabled={busy}
                      aria-pressed={v === 'fix'}
                      className={v === 'fix' ? 'on' : 'off'}
                      onClick={() => setState((m) => new Map(m).set(t.id, v === 'fix' ? 'keep' : 'fix'))}
                    >
                      <Fixed p={p} angle={t.angle} keystone={t.keystone} />
                      <span className="mono">{v === 'fix' ? `✓ ${fixLabel(t.angle, t.keystone)}` : v === 'keep' ? `As shot · tap to ${fixLabel(t.angle, t.keystone).toLowerCase()}` : 'Left out'}</span>
                    </button>
                    <button
                      className="btn ghost sm skip"
                      disabled={busy}
                      aria-pressed={v === 'skip'}
                      onClick={() => setState((m) => new Map(m).set(t.id, v === 'skip' ? 'fix' : 'skip'))}
                    >
                      {v === 'skip' ? 'Use it' : 'Skip photo'}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="ask-foot">
              {back}
              <span style={{ flex: 1 }} />
              <button className="btn ghost sm" onClick={() => setAskOpen(false)}>
                Later
              </button>
              <button className="btn sm primary" disabled={busy} onClick={applyTilts}>
                {busy ? 'Straightening…' : `Done (${tilts.filter((t) => stateOf(t.id) === 'fix').length} straightened)`}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Straighten this one?</h2>
            <p className="dim">
              {d.keystone && Math.abs(d.angle) < 0.05
                ? 'Its verticals lean (shot looking up or down), but they could be leaning on their own.'
                : `It looks about ${Math.abs(d.angle).toFixed(1)}° off level, but it could be on purpose.`}
            </p>
            <div className="ask-options n2">
              <button disabled={busy} onClick={() => choose(false)}>
                <img src={byId.get(d.photoId)!.thumb} alt="" />
                <span className="mono">As shot</span>
              </button>
              <button disabled={busy} onClick={() => choose(true)}>
                <Fixed p={byId.get(d.photoId)!} angle={d.angle} keystone={d.keystone} />
                <span className="mono">{fixLabel(d.angle, d.keystone)}</span>
              </button>
            </div>
          </>
        )}
        {!(d.kind === 'straighten' && tilts.length > 1) && (
          <div className="ask-foot">
            {back}
            <button className="btn ghost sm" disabled={busy} onClick={() => choose(d.kind === 'pick' ? d.suggested : false)}>
              {d.kind === 'pick' ? 'Use my pick' : 'Leave as shot'}
            </button>
            <button className="btn ghost sm" disabled={busy} onClick={() => choose('skip')} title="Leave out of the carousel">
              {d.kind === 'pick' ? 'Skip these' : 'Skip photo'}
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn ghost sm" disabled={busy} onClick={skipAll}>
              Use my picks for the rest
            </button>
            <button className="btn ghost sm" onClick={() => setAskOpen(false)}>
              Later
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
