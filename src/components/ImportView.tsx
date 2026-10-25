import { useRef, useState } from 'react';
import { useStore } from '../store';
import { loadFiles } from '../lib/importer';
import { driveConfigured, pickFromDrive } from '../lib/drive';
import { extractAlbumLink, fetchSharedAlbum } from '../lib/albumLink';
import { photosConfigured, photosSignedIn, pickFromGooglePhotos, signInToPhotos } from '../lib/gphotos';

type Entry = Parameters<typeof loadFiles>[0][number];

/** Walks dropped folders recursively. */
async function fromDrop(dt: DataTransfer): Promise<Entry[]> {
  const out: Entry[] = [];
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      const f = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ file: f, name: f.name, date: f.lastModified });
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        await Promise.all(batch.map(walk));
      } while (batch.length);
    }
  };
  const roots = [...dt.items].map((i) => i.webkitGetAsEntry()).filter(Boolean) as FileSystemEntry[];
  await Promise.all(roots.map(walk));
  return out;
}

export function ImportView() {
  const { addPhotos, setStep, importing, setImporting, analyze, photos, reset } = useStore();
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const [gp, setGp] = useState<'idle' | 'ready' | 'picking'>('idle');
  const gpAbort = useRef<AbortController | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState('');
  const [readingAlbum, setReadingAlbum] = useState(false);

  const importLink = async (url = link) => {
    if (!url.trim()) return linkRef.current?.focus();
    setError('');
    setReadingAlbum(true);
    try {
      const { entries } = await fetchSharedAlbum(url);
      setReadingAlbum(false);
      run(entries, 'photos');
    } catch (e) {
      setReadingAlbum(false);
      setError(String((e as Error).message ?? e));
    }
  };

  const run = async (entries: Entry[], source: 'local' | 'drive' | 'photos') => {
    setError('');
    if (!entries.length) return;
    setImporting({ done: 0, total: entries.length });
    const ps = await loadFiles(entries, source, (done, total) => setImporting({ done, total }));
    setImporting(null);
    if (!ps.length) return setError('No readable photos found there.');
    addPhotos(ps);
    setStep('curate');
    analyze();
  };

  const fromInput = (files: FileList | null) =>
    run([...(files ?? [])].map((f) => ({ file: f, name: f.name, date: f.lastModified })), 'local');

  const drive = async () => {
    try {
      run(await pickFromDrive(), 'drive');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const googlePhotos = async () => {
    setError('');
    // Without Google sign-in configured, the shared-link route needs no setup at all.
    if (!photosConfigured) return linkRef.current?.focus();
    // First tap signs in (Google's popup). The picker opens on the next tap, so the browser
    // treats it as a direct click and doesn't block the new tab.
    if (!photosSignedIn()) {
      try {
        await signInToPhotos();
        setGp('ready');
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
      return;
    }
    const win = window.open('', '_blank');
    win?.document.write(
      '<body style="margin:0;background:#0a0a0a;color:#888;font:14px system-ui;display:grid;place-items:center;height:100vh">Opening Google Photos…</body>',
    );
    gpAbort.current = new AbortController();
    setGp('picking');
    try {
      const entries = await pickFromGooglePhotos(win, gpAbort.current.signal);
      setGp('idle');
      if (entries.length) run(entries, 'photos');
    } catch (e) {
      setGp('idle');
      win?.close();
      setError(String((e as Error).message ?? e));
    }
  };

  return (
    <div className="import">
      <div
        className={`drop ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setOver(false);
          run(await fromDrop(e.dataTransfer), 'local');
        }}
      >
        {gp === 'picking' && !importing ? (
          <>
            <h1>Choose in Google Photos</h1>
            <p>
              Pick the photos in the Google Photos tab and tap <b>Done</b>. They'll appear here automatically.
            </p>
            <button
              className="btn"
              onClick={() => {
                gpAbort.current?.abort();
                setGp('idle');
              }}
            >
              Cancel
            </button>
          </>
        ) : importing ? (
          <>
            <h1>Reading photos</h1>
            <p className="mono">
              {importing.done} / {importing.total}
            </p>
            <div className="progress" style={{ maxWidth: 360, margin: '0 auto' }}>
              <div style={{ width: `${(importing.done / Math.max(1, importing.total)) * 100}%` }} />
            </div>
          </>
        ) : (
          <>
            <div className="mono faint" style={{ marginBottom: 20 }}>
              01 — Import
            </div>
            <h1>
              Bring a folder.
              <br />
              <span className="dim">Leave with a carousel.</span>
            </h1>
            <p>
              Seam reviews every frame like an art director: it keeps the candid, beautiful ones, drops the clichés and
              blinks, then lays them out as one seamless 4:5 story.
            </p>
            <div className="actions">
              <button className="btn primary" onClick={() => folderRef.current?.click()}>
                Choose folder
              </button>
              <button className="btn" onClick={() => filesRef.current?.click()}>
                Choose photos
              </button>
              <button
                className={`btn ${gp === 'ready' ? 'primary' : ''}`}
                onClick={googlePhotos}
              >
                {gp === 'ready' ? 'Open Google Photos →' : 'Google Photos'}
              </button>
              <button
                className="btn"
                onClick={drive}
                disabled={!driveConfigured}
                title={driveConfigured ? '' : 'Add a Google client ID to enable (see README)'}
              >
                Google Drive
              </button>
            </div>
            <form
              noValidate
              className="link-row"
              onSubmit={(e) => {
                e.preventDefault();
                importLink();
              }}
            >
              <input
                ref={linkRef}
                type="text"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Paste a Google Photos album link"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onPaste={(e) => {
                  const v = e.clipboardData.getData('text');
                  const found = extractAlbumLink(v);
                  if (found) {
                    e.preventDefault();
                    setLink(found);
                    importLink(found);
                  }
                }}
              />
              <button className="btn sm" disabled={readingAlbum}>
                {readingAlbum ? 'Reading…' : 'Import'}
              </button>
            </form>
            {error && (
              <p style={{ color: 'var(--bad)', marginTop: 20, marginBottom: 0 }}>
                {error.split('\n')[0]}
                {error.includes('\n') && (
                  <span className="mono faint" style={{ display: 'block', marginTop: 8, textTransform: 'none', userSelect: 'all' }}>
                    {error.split('\n')[1]}
                  </span>
                )}
              </p>
            )}
            <div className="foot mono">
              {photos.length ? (
                <>
                  {photos.length} photos loaded ·{' '}
                  <button className="btn ghost sm" onClick={() => setStep('curate')}>
                    Continue
                  </button>
                  <button className="btn ghost sm" onClick={reset}>
                    Clear
                  </button>
                </>
              ) : (
                'Or drop a folder here · Processed on your device'
              )}
            </div>
          </>
        )}
        <input
          ref={folderRef}
          type="file"
          hidden
          multiple
          // @ts-expect-error non-standard but universally supported
          webkitdirectory=""
          onChange={(e) => fromInput(e.target.files)}
        />
        <input ref={filesRef} type="file" hidden multiple accept="image/*,.heic,.heif" onChange={(e) => fromInput(e.target.files)} />
      </div>
    </div>
  );
}
