# Seam

Turn a folder of photos into a seamless, art-directed Instagram carousel.

Seam reviews every photo like an art director. It keeps the candid, beautiful, documentary-style frames and cuts the blurry, blinking, cliché and duplicate ones. Then it lays your picks out as one continuous canvas that slices into 4:5 slides (1080 × 1350), with panoramas across slides, layered insets, and framed gallery layouts in the style of SCRL.

Everything runs **on your device**. No photos are uploaded anywhere.

## How it works

| Step | What happens |
| --- | --- |
| **01 Import** | Pick a folder, select photos, drop a folder, or use Google Drive. HEIC is supported. |
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

## Google Drive setup (optional, about 5 minutes)

The **Google Drive** button stays disabled until these environment variables are set. If you'd rather skip this, install [Google Drive for desktop](https://www.google.com/drive/download/) and use **Choose folder** on the synced folder.

1. Open [console.cloud.google.com](https://console.cloud.google.com) and create a project.
2. Go to **APIs & Services → Library** and enable the **Google Drive API** and the **Google Picker API**.
3. Go to **APIs & Services → OAuth consent screen**:
   - Choose **External**, then fill in the app name and your email.
   - Under **Test users**, add your own Google account.
4. Go to **APIs & Services → Credentials**:
   - **Create credentials → OAuth client ID** of type **Web application**.
   - Under **Authorized JavaScript origins**, add your Vercel URL (e.g. `https://seam-yourname.vercel.app`) and `http://localhost:5173`.
   - **Create credentials → API key**. Optionally restrict it to the Picker API and your domain.
5. In Vercel, go to **Settings → Environment Variables** (or a local `.env` file, copied from `.env.example`) and set:
   ```
   VITE_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   VITE_GOOGLE_API_KEY=AIza...
   ```
6. Redeploy.

You can then pick a whole Drive folder, including subfolders, or individual photos. Files download directly from Google into your browser. While the app is in "Testing" mode, Google shows an "unverified app" notice; that's expected for a personal tool.

> **Google Photos:** since 2025, Google no longer lets apps read Google Photos albums. To use those photos, download the album or add it to a Drive folder.

## Notes

- Instagram allows up to 20 slides. Seam caps carousels at 20.
- Exports are sRGB JPEG at quality 95. Each slide renders separately, so long carousels work on phones.
- Built with React, TypeScript and Vite. The layout engine is in `src/lib/layout.ts`; adding a template means adding one entry to `TEMPLATES`.
