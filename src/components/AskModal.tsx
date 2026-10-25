import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { innerScale } from '../lib/straighten';
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

export function AskModal({ onDone }: { onDone: () => void }) {
  const { decisions, byId, resolve, setAskOpen } = useStore();
  const [total] = useState(decisions.length);
  const [busy, setBusy] = useState(false);
  // Similar-shot questions one at a time, then every tilt question together on one screen.
  const d = decisions.find((x) => x.kind === 'pick') ?? decisions[0];
  const tilts = decisions.filter((x): x is Extract<typeof x, { kind: 'straighten' }> => x.kind === 'straighten');
  const [off, setOff] = useState<Set<string>>(new Set());

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
    for (const t of tilts) await resolve(t.id, !off.has(t.id));
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
        ) : tilts.length > 1 ? (
          <>
            <h2>Straighten these?</h2>
            <p className="dim">
              These look off level. Tap any you'd rather keep as shot (a deliberate angle, say), then apply.
            </p>
            <div className="ask-options n3">
              {tilts.map((t) => {
                const p = byId.get(t.photoId)!;
                const on = !off.has(t.id);
                return (
                  <button
                    key={t.id}
                    disabled={busy}
                    aria-pressed={on}
                    className={on ? 'on' : 'off'}
                    onClick={() =>
                      setOff((o) => {
                        const x = new Set(o);
                        if (x.has(t.id)) x.delete(t.id);
                        else x.add(t.id);
                        return x;
                      })
                    }
                  >
                    {on ? <Leveled p={p} angle={t.angle} /> : <img src={p.thumb} alt="" />}
                    <span className="mono">{on ? `Straighten ${Math.abs(t.angle).toFixed(1)}°` : 'Keep as shot'}</span>
                  </button>
                );
              })}
            </div>
            <div className="ask-foot">
              <span style={{ flex: 1 }} />
              <button className="btn ghost sm" onClick={() => setAskOpen(false)}>
                Later
              </button>
              <button className="btn sm primary" disabled={busy} onClick={applyTilts}>
                {busy ? 'Straightening…' : `Apply (${tilts.length - off.size} straightened)`}
              </button>
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
        {!(d.kind === 'straighten' && tilts.length > 1) && (
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
        )}
      </div>
    </div>
  );
}
