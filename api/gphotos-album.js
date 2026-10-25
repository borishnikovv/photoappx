// Reads a public Google Photos shared-album link and returns its photos' image addresses.
// Google has no official API for this; the shared page embeds each photo as
// ["https://lh3.googleusercontent.com/pw/…", width, height, …], which is what we extract.
export const config = { runtime: 'edge' };

const ALLOWED = /^(photos\.app\.goo\.gl|goo\.gl|photos\.google\.com)$/;

export function parseAlbum(html) {
  const seen = new Set();
  const photos = [];
  const re = /\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_\-]+)",(\d+),(\d+)/g;
  for (let m; (m = re.exec(html)); ) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    photos.push({ url: m[1], width: +m[2], height: +m[3] });
  }
  const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? '';
  return { title: title.replace(/&#39;/g, "'").replace(/&amp;/g, '&'), photos };
}

export default async function handler(req) {
  const link = new URL(req.url).searchParams.get('url') ?? '';
  let u;
  try {
    u = new URL(link.trim());
  } catch {
    return json({ error: 'That doesn’t look like a link.' }, 400);
  }
  if (u.protocol !== 'https:' || !ALLOWED.test(u.hostname)) {
    return json({ error: 'Paste a Google Photos shared album link (photos.app.goo.gl/… or photos.google.com/share/…).' }, 400);
  }
  // Follow redirects one hop at a time so we never request anything outside Google Photos.
  let r;
  for (let hop = 0; ; hop++) {
    r = await fetch(u, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const next = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!next) break;
    u = new URL(next, u);
    if (hop > 5 || u.protocol !== 'https:' || !ALLOWED.test(u.hostname)) {
      return json({ error: 'That link didn’t lead to a Google Photos album.' }, 400);
    }
  }
  if (!r.ok) return json({ error: `Google Photos returned ${r.status}. Is the album still shared?` }, 502);
  const album = parseAlbum(await r.text());
  if (!album.photos.length) {
    return json({ error: 'No photos found. Make sure the album is shared with “anyone with the link”.' }, 404);
  }
  return json(album, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
