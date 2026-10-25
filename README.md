# Seam

Turn a folder of photos into a seamless, art-directed Instagram carousel.

Seam reviews every photo like an art director. It keeps the candid, beautiful, documentary-style frames and cuts the blurry, blinking, cliché and duplicate ones. Then it lays your picks out as one continuous canvas that slices into 4:5 slides (1080 × 1350), with panoramas across slides, layered insets, and framed gallery layouts in the style of SCRL.

Everything runs **on your device**. No photos are uploaded anywhere.

## How it works

| Step | What happens |
| --- | --- |
| **01 Import** | Pick a folder, select photos, drop a folder, paste a **Google Photos album link**, or sign in to Google Photos or Google Drive. HEIC is supported. |
| **02 Curate** | Each photo is scored on focus, exposure, faces (blinks, cut-off faces, expression), duplicates/bursts, and an on-device CLIP "art director" that judges candid/documentary/artful vs. posed, cliché, screenshot, distorted. Every photo gets plain-language reasons. Picks are ordered with a hero opener, then by **Story** (chronological) or **Color flow**. |
| **03 Compose** | Three layout variants (Balanced, Cinematic, Gallery) from a template library: full bleed, framed, off-center, stacked and staggered pairs, film strip, panoramas over 2–3 slides, inset on a panorama, corner inset, offset across the seam, overlap, spill-over. Faces are kept off slide seams automatically. Drag to move frames (with snapping to seams and margins), pan/zoom photos, toggle borders and shadows, swap photos, reorder or re-roll any section, and preview it in a swipeable Instagram mock. |
| **04 Export** | Full-resolution 1080 × 1350 JPEGs, as a .zip, or **Save to Photos** on a phone. Post them in order and the seams line up. |

### The on-device models

- **CLIP ViT-B/32** (via [transformers.js](https://github.com/huggingface/transformers.js)), about 90 MB and downloaded once from Hugging Face, then cached. It scores aesthetics and style with zero-shot prompts.
- **MediaPipe Face Landmarker**, about 4 MB. It finds faces, blinks and smiles, and supplies the focal points that keep faces off the seams.
- Classic pixel metrics: tile-based sharpness (so a shallow depth of field with a sharp subject still passes), exposure clipping, colorfulness, palette, and a 64-bit perceptual hash for bursts.

If the CLIP model can't load (offline on the first run, or a blocked network), Seam falls back to **basic mode**, which uses technical, face and duplicate signals only.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173.

## Deploy (free) on Vercel

1. Push this repo to GitHub.
2. Go to [vercel.com/new](https://vercel.com/new) and import the repo. The Vite settings are detected automatically.
3. (Optional) Add the Google Drive environment variables below, then deploy.

On your phone, open the URL and choose **Share → Add to Home Screen** to install it as an app.

## Google Photos: shared album link (no setup)

1. In Google Photos, open an album and tap **Share → Create link** (or copy its existing link).
2. In Seam, paste the link into **Paste a Google Photos album link**. It imports right away.

The album page is read by `api/gphotos-album.js` on Vercel, which only talks to Google Photos. Google has no official API for shared links, so this relies on the album page's current format. If Google changes that format, use the sign-in option below. Capture dates aren't on the shared page, so photos keep the album's order.

## Google Photos sign-in (optional, about 5 minutes)

Sign-in lets you pick any photos from your library, not just shared albums. It only needs **one** value: a Google client ID. You don't need an API key.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project (any name).
2. Go to **APIs & Services → Library**, search for **Google Photos Picker API**, and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen** (called "Google Auth Platform" in newer consoles):
   - Choose **External**, then fill in the app name and your email.
   - Under **Audience → Test users**, add your own Google account.
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Type: **Web application**.
   - Under **Authorized JavaScript origins**, add your Vercel URL (e.g. `https://photoappx.vercel.app`). Add `http://localhost:5173` too if you run it locally.
   - Copy the client ID (it ends in `.apps.googleusercontent.com`).
5. In Vercel, go to **Project → Settings → Environment Variables**, add `VITE_GOOGLE_CLIENT_ID` with that value, then **Redeploy**.

**Using it:**
1. Tap **Google Photos** and sign in. Google shows an "unverified app" notice while the app is in testing mode; tap **Continue**.
2. Tap **Open Google Photos →**. Your Google Photos opens in a new tab.
3. Select photos. You can open an album and select everything. Then tap **Done**.
4. The tab closes and the photos load into Seam.

Photos download straight from Google to your browser. The app includes a small pass-through (`api/gphoto.js`, run by Vercel) that only accepts Google's photo hosts, in case Google refuses direct browser downloads. Nothing is stored.

## Google Drive setup (optional)

For Drive, follow the same steps, but also:
- enable the **Google Drive API** and **Google Picker API** in step 2;
- create an **API key** under **Credentials** and set it as `VITE_GOOGLE_API_KEY`.

If you'd rather skip Drive setup, install [Google Drive for desktop](https://www.google.com/drive/download/) and use **Choose folder** on the synced folder.

## Notes

- Instagram allows up to 20 slides. Seam caps carousels at 20.
- Exports are sRGB JPEG at quality 95. Each slide renders separately, so long carousels work on phones.
- Built with React, TypeScript and Vite. The layout engine is in `src/lib/layout.ts`; adding a template means adding one entry to `TEMPLATES`.
