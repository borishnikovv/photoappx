import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { innerScale } from '../lib/straighten';
import type { Photo } from '../types';

/** The thumbnail rotated and cropped the way straightening would, as a cheap preview. */
function Leveled({ p, angle }: { p: Photo; angle: number }) {
  const rad = (-angle * Math.PI) / 180;
  const s = innerScale(p.width, p.height, rad);
  return (
    <div style={{ aspectRatio: `${p.width} / ${p.height}`, overflow: 'hidden', borderRadius: 4, background: 'var(--bg-2)' }}>
      <img src={p.thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `rotate(${-angle}deg) scale(${1 / s})` }} />
    </div>
  );
}

export function AskModal({ onDone }: { onDone: () => void }) {
  const { decisions, byId, resolve, setAskOpen } = useStore();
  const [total] = useState(decisions.length);
  const [busy, setBusy] = useState(false);
  const d = decisions[0];

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

  return (
    <div className="modal ask">
      <div className="ask-card">
        <div className="mono faint">
          Help me choose · {step} of {total}
        </div>
        {d.kind === 'pick' ? (
          <>
            <h2>These are nearly tied. Which one?</h2>
            <p className="dim">Similar shots scored within a few points. Tap the one to keep.</p>
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
        ) : (
          <>
            <h2>Straighten this one?</h2>
            <p className="dim">It looks about {Math.abs(d.angle).toFixed(1)}° off level, but it could be on purpose.</p>
            <div className="ask-options n2">
              <button disabled={busy} onClick={() => choose(false)}>
                <img src={byId.get(d.photoId)!.thumb} alt="" />
                <span className="mono">As shot</span>
              </button>
              <button disabled={busy} onClick={() => choose(true)}>
                <Leveled p={byId.get(d.photoId)!} angle={d.angle} />
                <span className="mono">Straightened</span>
              </button>
            </div>
          </>
        )}
        <div className="ask-foot">
          <button className="btn ghost sm" disabled={busy} onClick={() => choose(d.kind === 'pick' ? d.suggested : false)}>
            {d.kind === 'pick' ? 'Use my pick' : 'Leave as shot'}
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm" disabled={busy} onClick={skipAll}>
            Use my picks for the rest
          </button>
          <button className="btn ghost sm" onClick={() => setAskOpen(false)}>
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
