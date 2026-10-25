// Import from a Google Photos shared-album link: no sign-in or Google setup needed.
// The album page is read by api/gphotos-album.js (browsers can't fetch it directly).
import type { DriveEntry } from './drive';

const LINK_RE = /https?:\/\/(?:photos\.app\.goo\.gl|goo\.gl|photos\.google\.com)\/[^\s"'<>]+/;

/** Pulls an album link out of whatever was pasted (quotes, spaces, surrounding text). */
export const extractAlbumLink = (s: string) => s.match(LINK_RE)?.[0].replace(/^http:/, 'https:') ?? null;

export async function fetchSharedAlbum(text: string): Promise<{ title: string; link: string; thumbs: string[]; entries: DriveEntry[] }> {
  const link = extractAlbumLink(text);
  if (!link) throw new Error('Paste a Google Photos album link, like https://photos.app.goo.gl/…');
  const r = await fetch(`/api/gphotos-album?url=${encodeURIComponent(link)}`);
  const body = await r.json().catch(() => ({
    error:
      r.status === 404
        ? 'Album links need the deployed site (Vercel): the album reader isn’t available here.'
        : `Couldn’t read the album (error ${r.status}).`,
  }));
  if (!r.ok) throw new Error(body.debug ? `${body.error}\n[${body.debug}]` : body.error);
  // No capture dates on the shared page, so keep the album's own order.
  const base = Date.now() - body.photos.length * 1000;
  return {
    title: body.title,
    link,
    // Small square previews straight from Google, for confirming it's the right album.
    thumbs: body.photos.slice(0, 12).map((p: { url: string }) => `${p.url}=w240-h240-c`),
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
