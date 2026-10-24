import { useRef, useState } from 'react';
import { useStore } from '../store';
import { loadFiles } from '../lib/importer';
import { driveConfigured, pickFromDrive } from '../lib/drive';

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

  const run = async (entries: Entry[], source: 'local' | 'drive') => {
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
        {importing ? (
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
                className="btn"
                onClick={drive}
                disabled={!driveConfigured}
                title={driveConfigured ? '' : 'Add a Google client ID to enable (see README)'}
              >
                Google Drive
              </button>
            </div>
            {error && <p style={{ color: 'var(--bad)', marginTop: 20, marginBottom: 0 }}>{error}</p>}
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
