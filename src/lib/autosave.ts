// Saves the open project a moment after anything changes. Photos are written once (and again
// when their analysis lands or they're straightened); the rest is small and written in full.
import { useStore } from '../store';
import { savePhotos, saveState } from './projects';

let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> = Promise.resolve();
let cover: { id: string; blob: Blob } | null = null;

async function save() {
  const s = useStore.getState();
  if (!s.projectId || s.importing || !s.photos.length) return;
  const id = s.projectId;
  await savePhotos(id, s.photos);
  const coverId = s.picks[0] ?? s.photos[0].id;
  if (cover?.id !== coverId) {
    const p = s.byId.get(coverId);
    cover = p ? { id: coverId, blob: await fetch(p.thumb).then((r) => r.blob()) } : null;
  }
  await saveState({
    id,
    name: s.projectName,
    createdAt: s.createdAt,
    updatedAt: Date.now(),
    photoIds: s.photos.map((p) => p.id),
    picks: s.picks,
    count: s.count,
    seq: s.seq,
    style: s.style,
    carousels: s.carousels,
    active: s.active,
    decisions: s.decisions,
    drafts: s.drafts,
    step: s.step,
    groups: s.photos.map((p) => [p.id, p.analysis?.groupId, p.analysis?.groupBest]),
    smartMode: s.smartMode,
    cover: cover?.blob,
  });
}

export function startAutosave() {
  useStore.subscribe((s, prev) => {
    if (s.selected !== prev.selected && s.carousels === prev.carousels && s.photos === prev.photos) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // One save at a time; a save that fails (storage full, private mode) never breaks the app.
      running = running.then(save).catch((e) => console.warn('Autosave failed', e));
    }, 1200);
  });
}
