// Projects saved on this device (IndexedDB), so a refresh or a closed tab never loses work.
// Photos are stored once each (and again only when one changes, e.g. after straightening); the
// lightweight state — picks, answers, layouts, settings, drafts — is saved after every change.
import type { Carousel, Decision, FaceBox, Photo, StyleOptions } from '../types';

const DB = 'seam';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

const tx = async <T,>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => T): Promise<T> => {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
};
const req = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

export interface Draft {
  id: string;
  name: string;
  savedAt: number;
  carousels: Carousel[];
  active: number;
  style: StyleOptions;
}

export interface ProjectState {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  photoIds: string[];
  picks: string[];
  count: number;
  seq: string;
  style: StyleOptions;
  carousels: Carousel[];
  active: number;
  decisions: Decision[];
  drafts: Draft[];
  step: string;
  /** Duplicate groups change in place after analysis, so they're kept here: [photoId, groupId, best]. */
  groups: [string, string | undefined, boolean | undefined][];
  smartMode: boolean | null;
  cover?: Blob;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  photos: number;
  cover?: string;
}

/** A photo as stored: blobs instead of object URLs. */
type StoredPhoto = Omit<Photo, 'thumb' | 'original'> & {
  key: string;
  thumbBlob: Blob;
  original?: { file: Blob; width: number; height: number; thumbBlob: Blob; faces?: FaceBox[] };
};

const blobOf = (url: string) => fetch(url).then((r) => r.blob());
// What was last written for each photo object: analysis lands on the same object later, so a
// photo is written again once its analysis arrives (or the object is replaced, e.g. straightened).
const saved = new WeakMap<Photo, Photo['analysis'] | null>();

export async function savePhotos(projectId: string, photos: Photo[]) {
  const fresh = photos.filter((p) => !saved.has(p) || saved.get(p) !== (p.analysis ?? null));
  if (!fresh.length) return;
  const rows: StoredPhoto[] = [];
  for (const p of fresh) {
    const { thumb, original, ...rest } = p;
    rows.push({
      ...rest,
      key: `${projectId}:${p.id}`,
      thumbBlob: await blobOf(thumb),
      original: original && { file: original.file, width: original.width, height: original.height, faces: original.faces, thumbBlob: await blobOf(original.thumb) },
    });
  }
  await tx(['photos'], 'readwrite', (t) => rows.forEach((r) => t.objectStore('photos').put(r)));
  fresh.forEach((p) => saved.set(p, p.analysis ?? null));
}

export async function saveState(state: ProjectState) {
  await tx(['projects'], 'readwrite', (t) => t.objectStore('projects').put(state));
}

export async function listProjects(): Promise<ProjectSummary[]> {
  try {
    const all = await tx(['projects'], 'readonly', (t) => req(t.objectStore('projects').getAll() as IDBRequest<ProjectState[]>));
    const rows = await all;
    return rows
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, photos: p.photoIds.length, cover: p.cover ? URL.createObjectURL(p.cover) : undefined }));
  } catch {
    return [];
  }
}

export async function loadProject(id: string): Promise<{ state: ProjectState; photos: Photo[] } | null> {
  const state = await (await tx(['projects'], 'readonly', (t) => req(t.objectStore('projects').get(id) as IDBRequest<ProjectState | undefined>)));
  if (!state) return null;
  const rows = await (await tx(['photos'], 'readonly', (t) =>
    req(t.objectStore('photos').getAll(IDBKeyRange.bound(`${id}:`, `${id}:￿`)) as IDBRequest<StoredPhoto[]>),
  ));
  const photos: Photo[] = rows.map(({ key: _key, thumbBlob, original, ...p }) => {
    const photo: Photo = {
      ...(p as Omit<Photo, 'thumb'>),
      thumb: URL.createObjectURL(thumbBlob),
      original: original && { file: original.file, width: original.width, height: original.height, faces: original.faces, thumb: URL.createObjectURL(original.thumbBlob) },
    };
    saved.set(photo, photo.analysis ?? null);
    return photo;
  });
  return { state, photos };
}

export async function deleteProject(id: string) {
  await tx(['projects', 'photos'], 'readwrite', (t) => {
    t.objectStore('projects').delete(id);
    t.objectStore('photos').delete(IDBKeyRange.bound(`${id}:`, `${id}:￿`));
  });
}

/** Forget photos that were removed from a project. */
export async function prunePhotos(projectId: string, keep: Set<string>) {
  const keys = await (await tx(['photos'], 'readonly', (t) =>
    req(t.objectStore('photos').getAllKeys(IDBKeyRange.bound(`${projectId}:`, `${projectId}:￿`)) as IDBRequest<IDBValidKey[]>),
  ));
  const gone = (keys as string[]).filter((k) => !keep.has(k.slice(projectId.length + 1)));
  if (gone.length) await tx(['photos'], 'readwrite', (t) => gone.forEach((k) => t.objectStore('photos').delete(k)));
}
