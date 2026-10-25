import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { canShareFiles, downloadBlob, downloadZip, renderPanorama, renderSlides, shareSlides } from '../lib/exporter';

export function ExportView() {
  const { carousels, active, byId, style, setStep } = useStore();
  const c = carousels[active];
  const [slides, setSlides] = useState<Blob[]>([]);
  const [urls, setUrls] = useState<string[]>([]);
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!c) return;
    let live = true;
    setSlides([]);
    renderSlides(c, byId, style, (i, n) => live && setProgress([i, n])).then((b) => {
      if (!live) return;
      setSlides(b);
      setUrls(b.map((x) => URL.createObjectURL(x)));
    });
    return () => {
      live = false;
    };
  }, [c, byId, style]);

  useEffect(() => () => urls.forEach(URL.revokeObjectURL), [urls]);

  if (!c) return <div className="empty">Nothing to export yet.</div>;
  const ready = slides.length > 0;

  return (
    <div className="export">
      <div className="mono faint" style={{ marginBottom: 14 }}>
        04 — Export
      </div>
      <h2>{ready ? `${slides.length} slides, ready to post` : 'Rendering at full resolution…'}</h2>
      <p className="dim" style={{ margin: 0 }}>
        1080 × 1350 · 4:5 · JPEG, lightly sharpened for Instagram. Post them in order as one carousel and the seams line up.
      </p>
      {!ready && (
        <div className="progress" style={{ maxWidth: 360, marginTop: 20 }}>
          <div style={{ width: `${(progress[0] / Math.max(1, progress[1])) * 100}%` }} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 24, flexWrap: 'wrap' }}>
        {canShareFiles() && (
          <button
            className="btn primary"
            disabled={!ready}
            onClick={() => shareSlides(slides).catch((e) => e.name !== 'AbortError' && setMsg('Sharing failed, try Download.'))}
          >
            Save to Photos
          </button>
        )}
        <button className={`btn ${canShareFiles() ? '' : 'primary'}`} disabled={!ready} onClick={() => downloadZip(slides, `seam-${c.name.toLowerCase()}`)}>
          Download .zip
        </button>
        <button
          className="btn"
          disabled={!ready}
          title="All slides as one long image"
          onClick={async () => downloadBlob(await renderPanorama(slides), `seam-${c.name.toLowerCase()}-panorama.jpg`)}
        >
          Panorama
        </button>
        <button className="btn ghost" onClick={() => setStep('compose')}>
          Back to edit
        </button>
      </div>
      {msg && <p style={{ color: 'var(--bad)' }}>{msg}</p>}
      <div className="slides">
        {urls.map((u, i) => (
          <figure key={u}>
            <a href={u} download={`slide-${String(i + 1).padStart(2, '0')}.jpg`}>
              <img src={u} alt={`Slide ${i + 1}`} />
            </a>
            <figcaption className="mono faint">{String(i + 1).padStart(2, '0')}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
