// Google Photos via the official Photos Picker API: the user picks photos in Google Photos itself,
// then Seam downloads just those. Needs only VITE_GOOGLE_CLIENT_ID (see README).
import { GOOGLE_CLIENT_ID, accessToken, cachedToken } from './google';
import type { DriveEntry } from './drive';

const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const API = 'https://photospicker.googleapis.com/v1';

export const photosConfigured = Boolean(GOOGLE_CLIENT_ID);
export const photosSignedIn = () => Boolean(cachedToken(SCOPE));
export const signInToPhotos = () => accessToken(SCOPE);

async function call(path: string, init: RequestInit = {}) {
  const t = await accessToken(SCOPE);
  const r = await fetch(`${API}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`Google Photos error ${r.status}`);
  return r.status === 204 ? null : r.json();
}

/** "5s" / "1.5s" → ms */
const duration = (s: string | undefined, fallback: number) => (s ? parseFloat(s) * 1000 : fallback);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens the Google Photos picker in `win` (a tab opened synchronously from the click, so it isn't
 * blocked as a popup), waits for the user to finish, and returns the chosen photos.
 */
export async function pickFromGooglePhotos(win: Window | null, signal: AbortSignal): Promise<DriveEntry[]> {
  const session = await call('sessions', { method: 'POST', body: '{}' });
  const url = `${session.pickerUri}/autoclose`;
  if (win && !win.closed) win.location.href = url;
  else window.open(url, '_blank');

  const interval = duration(session.pollingConfig?.pollInterval, 3000);
  const deadline = Date.now() + duration(session.pollingConfig?.timeoutIn, 30 * 60_000);
  let closedPolls = 0;
  for (;;) {
    await sleep(interval);
    if (signal.aborted || Date.now() > deadline) return cleanup(session.id, []);
    const s = await call(`sessions/${session.id}`);
    if (s.mediaItemsSet) break;
    // The tab was closed without choosing anything: give Google a moment, then give up.
    if (win?.closed && ++closedPolls > 3) return cleanup(session.id, []);
  }

  const items: any[] = [];
  let page = '';
  do {
    const r = await call(`mediaItems?sessionId=${session.id}&pageSize=100${page ? `&pageToken=${page}` : ''}`);
    items.push(...(r.mediaItems ?? []));
    page = r.nextPageToken ?? '';
  } while (page);

  return items
    .filter((m) => m.type !== 'VIDEO')
    .map((m) => ({
      name: m.mediaFile?.filename ?? `${m.id}.jpg`,
      date: m.createTime ? +new Date(m.createTime) : undefined,
      // Large JPEG render (fits within 4096px): plenty for 1080px slides, even 3-slide panoramas.
      file: () => download(`${m.mediaFile.baseUrl}=w4096-h4096`),
    }));
}

async function cleanup<T>(id: string, value: T) {
  call(`sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  return value;
}

async function download(url: string): Promise<Blob> {
  const headers = { Authorization: `Bearer ${await accessToken(SCOPE)}` };
  try {
    const r = await fetch(url, { headers });
    if (r.ok) return r.blob();
  } catch {
    // Google's image host may refuse cross-origin requests; fall through to our tiny relay.
  }
  const r = await fetch(`/api/gphoto?url=${encodeURIComponent(url)}`, { headers });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  return r.blob();
}
