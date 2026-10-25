// Relays a Google Photos image download for the browser, in case Google's image host refuses
// cross-origin requests. Only Google's photo hosts are allowed, and the user's own token is
// passed through; nothing is stored.
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const target = new URL(req.url).searchParams.get('url');
  let u;
  try {
    u = new URL(target);
  } catch {
    return new Response('Bad url', { status: 400 });
  }
  if (u.protocol !== 'https:' || !/(^|\.)googleusercontent\.com$/.test(u.hostname)) {
    return new Response('Forbidden host', { status: 403 });
  }
  const auth = req.headers.get('authorization');
  if (!auth) return new Response('Missing token', { status: 401 });
  const r = await fetch(u, { headers: { Authorization: auth } });
  return new Response(r.body, {
    status: r.status,
    headers: { 'Content-Type': r.headers.get('content-type') ?? 'image/jpeg', 'Cache-Control': 'private, no-store' },
  });
}
