export type Orientation = 'portrait' | 'square' | 'landscape' | 'pano';
export type Family = 'mosaic' | 'spread' | 'pano' | 'layered' | 'gallery';

export interface FaceBox {
  /** Normalized 0..1 in photo space. */
  x: number;
  y: number;
  w: number;
  h: number;
  eyesClosed: number;
  smile: number;
}

export interface Analysis {
  sharpness: number;
  exposure: number;
  colorfulness: number;
  /** Mean color in Lab, used for color-flow sequencing. */
  lab: [number, number, number];
  /** Hex swatches, dominant first. */
  palette: string[];
  hash: string;
  /** Appearance fingerprint: 8×8 Lab layout and a sqrt color histogram (see metrics.ts). */
  grid: number[];
  hist: number[];
  detail?: number[];
  /** CLIP image embedding, when the vision model is available. */
  embedding?: Float32Array;
  aesthetic?: number;
  style?: number;
  faces?: FaceBox[];
  /** 0..100 */
  score: number;
  reject: boolean;
  reasons: string[];
  groupId?: string;
  groupBest?: boolean;
  tilt?: number;
  tiltConfidence?: number;
  tiltSource?: 'horizon' | 'lines' | 'objects' | 'none';
  keystone?: number;
  keystoneConfidence?: number;
}

export interface Photo {
  id: string;
  name: string;
  source: 'local' | 'drive' | 'photos';
  file: Blob;
  width: number;
  height: number;
  date: number;
  camera?: string;
  thumb: string;
  analysis?: Analysis;
  /** Degrees this photo was rotated to level it, with the untouched original kept for undo. */
  straightened?: number;
  /** Keystone (skew) correction applied, in degrees of lean at the frame's sides. */
  keystone?: number;
  original?: { file: Blob; width: number; height: number; thumb: string; faces?: FaceBox[] };
}

export type Decision =
  | { id: string; kind: 'pick'; groupId: string; options: string[]; suggested: string }
  | { id: string; kind: 'straighten'; photoId: string; angle: number };

export interface Crop {
  /** Focal center of the visible window, normalized in photo space. */
  fx: number;
  fy: number;
  /** 1 = cover; >1 zooms in. */
  zoom: number;
}

export interface Item {
  id: string;
  photoId: string;
  /** Position in canvas px, relative to the section's first slide. */
  x: number;
  y: number;
  w: number;
  h: number;
  crop: Crop;
  border: number;
  shadow: boolean;
  z: number;
  /** A photo laid on top of a slide edge, so the swipe reads as one continuous canvas. */
  bridge?: boolean;
  /** Backdrop that fills its slides edge to edge; it pans instead of moving, so nothing is ever left empty. */
  base?: boolean;
}

export interface Section {
  id: string;
  /** Kept exactly as is (place and content) when the carousel is regenerated. */
  pinned?: boolean;
  template: string;
  span: number;
  photoIds: string[];
  items: Item[];
}

export interface Carousel {
  id: string;
  name: string;
  seed: number;
  sections: Section[];
  /** Background drawn from the photos, used when the style's background is 'auto'. */
  ground?: string;
}

export interface StyleOptions {
  families: Record<Family, boolean>;
  /** A color, or 'auto' to derive a light/dark ground from the photos' own palette. */
  bg: string;
  frame: string;
  /** How photos laid on top look: clean edges (no frame, no shadow) or framed like prints. */
  overlay: 'clean' | 'framed';
  maxSlides: number;
}
