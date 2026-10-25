// The first slide does two jobs on its own: it's the post in the feed until someone swipes, and
// the profile grid shows it cropped to 3:4. This checks what those views cut.
import type { Carousel, Photo } from '../types';
import { SLIDE_H, SLIDE_W, absoluteItems, sourceRect } from './geometry';

/** The profile grid crops 4:5 slides to 3:4, trimming the sides. */
export const GRID_W = Math.round((SLIDE_H * 3) / 4);
export const GRID_X = (SLIDE_W - GRID_W) / 2;

export interface GridIssue {
  photoId: string;
  text: string;
}

export function firstSlideCheck(c: Carousel, photos: Map<string, Photo>): GridIssue[] {
  const items = absoluteItems(c);
  const issues: GridIssue[] = [];
  const say = (photoId: string, text: string) => !issues.some((i) => i.text === text) && issues.push({ photoId, text });
  for (const it of items) {
    if (it.ax >= SLIDE_W || it.ax + it.w <= 0) continue;
    const p = photos.get(it.photoId);
    if (!p) continue;
    const { sx, sy, sw, sh } = sourceRect(p, it);
    // Faces in canvas pixels, kept only where this frame actually shows them.
    for (const f of p.analysis?.faces ?? []) {
      const x = it.ax + ((f.x - sx) / sw) * it.w, w = (f.w / sw) * it.w;
      const y = it.y + ((f.y - sy) / sh) * it.h, h = (f.h / sh) * it.h;
      if (x + w < it.ax || x > it.ax + it.w || y + h < it.y || y > it.y + it.h || w < 40) continue;
      // Covered by a photo stacked above it?
      const cx = x + w / 2, cy = y + h / 2;
      if (items.some((o) => o.z > it.z && cx > o.ax && cx < o.ax + o.w && cy > o.y && cy < o.y + o.h)) continue;
      if (x < SLIDE_W && x + w > SLIDE_W) say(it.photoId, 'A face is split by the first swipe — it shows only half until people swipe.');
      else if (x < GRID_X + GRID_W && x + w > GRID_X + GRID_W && x < SLIDE_W) say(it.photoId, 'The profile grid crops a face on the right edge.');
      else if (x < GRID_X && x + w > GRID_X) say(it.photoId, 'The profile grid crops a face on the left edge.');
    }
  }
  // A cover that's mostly the start of something cut off reads as a fragment in the grid.
  const main = items.filter((it) => it.ax < SLIDE_W && it.ax + it.w > 0).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (main && main.ax + main.w > SLIDE_W) {
    const shown = (Math.min(SLIDE_W, main.ax + main.w) - Math.max(0, main.ax)) / main.w;
    if (shown < 0.4) say(main.photoId, 'The cover shows less than half of its main photo — the grid may read as a fragment.');
  }
  return issues;
}
