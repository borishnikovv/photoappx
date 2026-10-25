// Shared Google sign-in (Google Identity Services token flow), used by Drive and Photos.

declare const google: any;

export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

const scripts = new Map<string, Promise<void>>();
export function script(src: string) {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => res();
      s.onerror = () => rej(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
    scripts.set(src, p);
  }
  return p;
}

const tokens = new Map<string, { value: string; expires: number }>();

/** A cached token for this scope, without prompting. */
export function cachedToken(scope: string) {
  const t = tokens.get(scope);
  return t && t.expires > Date.now() + 60_000 ? t.value : null;
}

/** Signs in (Google's own popup) if needed and returns an access token for the scope. */
export async function accessToken(scope: string): Promise<string> {
  const cached = cachedToken(scope);
  if (cached) return cached;
  await script('https://accounts.google.com/gsi/client');
  return new Promise((res, rej) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope,
      callback: (r: any) => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        tokens.set(scope, { value: r.access_token, expires: Date.now() + r.expires_in * 1000 });
        res(r.access_token);
      },
      error_callback: (e: any) => rej(new Error(e?.message || 'Google sign-in was cancelled')),
    });
    client.requestAccessToken({ prompt: tokens.has(scope) ? '' : 'consent' });
  });
}
