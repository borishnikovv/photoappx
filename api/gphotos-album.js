// Reads a public Google Photos shared-album link and returns its photos' image addresses.
// Google has no official API for this; the shared page embeds each photo as
// ["https://lh3.googleusercontent.com/pw/…", width, height, …], which is what we extract.
export const config = { runtime: 'edge' };

const ALLOWED = /^(photos\.app\.goo\.gl|goo\.gl|photos\.google\.com)$/;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  // Pre-answers Google's EU cookie-consent interstitial, which servers in Europe otherwise get.
  'Cookie': 'CONSENT=YES+cb; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg',
};

export function parseAlbum(html) {
  const seen = new Set();
  const photos = [];
  const add = (url, width, height) => {
    if (seen.has(url)) return;
    seen.add(url);
    photos.push({ url, width, height });
  };
  const withSize = /\["(https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_\-]+)",(\d+),(\d+)/g;
  for (let m; (m = withSize.exec(html)); ) add(m[1], +m[2], +m[3]);
  // Looser fallback if Google changes the surrounding structure: any album image address.
  if (!photos.length) {
    const any = /https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_\-]{20,}/g;
    for (const m of html.matchAll(any)) add(m[0], 0, 0);
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
    r = await fetch(u, { redirect: 'manual', headers: HEADERS });
    const next = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!next) break;
    u = new URL(next, u);
    if (u.hostname === 'consent.google.com') {
      return json({ error: 'Google asked for cookie consent instead of showing the album. Try again in a minute, or use Google Photos sign-in.' }, 502);
    }
    if (hop > 5 || u.protocol !== 'https:' || !ALLOWED.test(u.hostname)) {
      return json({ error: `That link didn’t lead to a Google Photos album (it went to ${u.hostname}).` }, 400);
    }
  }
  if (r.status === 404) return json({ error: 'Google says this album doesn’t exist. Is the link complete and still shared?' }, 404);
  if (!r.ok) return json({ error: `Google Photos returned an error (${r.status}).` }, 502);
  const html = await r.text();
  const album = parseAlbum(html);
  if (!album.photos.length) {
    const signIn = /accounts\.google\.com\/ServiceLogin|Sign in - Google Accounts/.test(html);
    return json(
      {
        error: signIn
          ? 'This album is private. In Google Photos, turn on link sharing for it.'
          : 'No photos found on that album page. Make sure link sharing is on, then try again.',
      },
      404,
    );
  }
  return json(album, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
