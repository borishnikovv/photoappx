export type Orientation = 'portrait' | 'square' | 'landscape' | 'pano';
export type Family = 'pano' | 'layered' | 'gallery';

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
}

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
}

export interface Section {
  id: string;
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
}

export interface StyleOptions {
  families: Record<Family, boolean>;
  bg: string;
  frame: string;
  maxSlides: number;
}
