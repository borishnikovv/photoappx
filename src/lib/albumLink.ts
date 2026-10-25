// Import from a Google Photos shared-album link: no sign-in or Google setup needed.
// The album page is read by api/gphotos-album.js (browsers can't fetch it directly).
import type { DriveEntry } from './drive';

export const looksLikeAlbumLink = (s: string) => /^https:\/\/(photos\.app\.goo\.gl|goo\.gl|photos\.google\.com)\//.test(s.trim());

export async function fetchSharedAlbum(link: string): Promise<{ title: string; entries: DriveEntry[] }> {
  const r = await fetch(`/api/gphotos-album?url=${encodeURIComponent(link.trim())}`);
  const body = await r.json().catch(() => ({ error: `Couldn’t read the album (${r.status}).` }));
  if (!r.ok) throw new Error(body.error);
  // No capture dates on the shared page, so keep the album's own order.
  const base = Date.now() - body.photos.length * 1000;
  return {
    title: body.title,
    entries: body.photos.map((p: { url: string }, i: number) => ({
      name: `${body.title || 'album'}-${String(i + 1).padStart(3, '0')}.jpg`,
      date: base + i * 1000,
      file: () => download(`${p.url}=w4096-h4096`),
    })),
  };
}

async function download(url: string): Promise<Blob> {
  try {
    const r = await fetch(url);
    if (r.ok) return r.blob();
  } catch {
    // Cross-origin refused: use the relay.
  }
  const r = await fetch(`/api/gphoto?url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  return r.blob();
}
