// Google Drive picker. Needs VITE_GOOGLE_CLIENT_ID and VITE_GOOGLE_API_KEY (see README).
// Photos are downloaded straight from Google into the browser; nothing passes through a server.

import { GOOGLE_CLIENT_ID, accessToken as signIn, script } from './google';

declare const google: any;
declare const gapi: any;

const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined;
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const accessToken = () => signIn(SCOPE);

export const driveConfigured = Boolean(GOOGLE_CLIENT_ID && API_KEY);

export interface DriveEntry {
  name: string;
  date?: number;
  file: () => Promise<Blob>;
}

async function api(path: string, t: string) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/${path}`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) throw new Error(`Drive error ${r.status}`);
  return r;
}

const FIELDS = 'nextPageToken,files(id,name,mimeType,createdTime,imageMediaMetadata/time)';

/** All images inside a folder, including nested folders. */
async function listFolder(id: string, t: string, depth = 0): Promise<any[]> {
  const out: any[] = [];
  let page = '';
  do {
    const q = encodeURIComponent(`'${id}' in parents and trashed = false and (mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.folder')`);
    const r = await (await api(`files?q=${q}&fields=${FIELDS}&pageSize=1000&pageToken=${page}`, t)).json();
    for (const f of r.files) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        if (depth < 3) out.push(...(await listFolder(f.id, t, depth + 1)));
      } else out.push(f);
    }
    page = r.nextPageToken ?? '';
  } while (page);
  return out;
}

function exifTime(s?: string) {
  // Drive reports EXIF time as "2024:06:01 18:22:10".
  if (!s) return undefined;
  const d = new Date(s.replace(/^(\d+):(\d+):(\d+)/, '$1-$2-$3T').replace('T ', 'T'));
  return isNaN(+d) ? undefined : +d;
}

/** Opens the Google Drive picker; resolves with the chosen images (folders are expanded). */
export async function pickFromDrive(): Promise<DriveEntry[]> {
  if (!driveConfigured) throw new Error('Google Drive is not configured');
  const t = await accessToken();
  await script('https://apis.google.com/js/api.js');
  await new Promise<void>((res) => gapi.load('picker', () => res()));

  const docs: any[] = await new Promise((res) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes('image/jpeg,image/png,image/heic,image/heif,image/webp,application/vnd.google-apps.folder')
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMode(google.picker.DocsViewMode.GRID);
    new google.picker.PickerBuilder()
      .addView(view)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(t)
      .setDeveloperKey(API_KEY)
      .setTitle('Choose a folder or photos')
      .setCallback((d: any) => {
        if (d.action === google.picker.Action.PICKED) res(d.docs);
        if (d.action === google.picker.Action.CANCEL) res([]);
      })
      .build()
      .setVisible(true);
  });

  const files: any[] = [];
  for (const d of docs) {
    if (d.mimeType === 'application/vnd.google-apps.folder') files.push(...(await listFolder(d.id, t)));
    else files.push((await (await api(`files/${d.id}?fields=id,name,mimeType,createdTime,imageMediaMetadata/time`, t)).json()));
  }
  return files.map((f) => ({
    name: f.name,
    date: exifTime(f.imageMediaMetadata?.time) ?? (f.createdTime ? +new Date(f.createdTime) : undefined),
    file: async () => (await api(`files/${f.id}?alt=media`, await accessToken())).blob(),
  }));
}
