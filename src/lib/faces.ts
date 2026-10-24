import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import type { FaceBox } from '../types';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let landmarker: Promise<FaceLandmarker | null> | null = null;

function load() {
  landmarker ??= (async () => {
    try {
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const files = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe-wasm`);
      const make = (delegate: 'GPU' | 'CPU') =>
        FaceLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'IMAGE',
          numFaces: 8,
          outputFaceBlendshapes: true,
          minFaceDetectionConfidence: 0.5,
        });
      return await make('GPU').catch(() => make('CPU'));
    } catch (err) {
      console.warn('Face model unavailable', err);
      return null;
    }
  })();
  return landmarker;
}

export const facesAvailable = () => load().then(Boolean);

export async function detectFaces(blob: Blob): Promise<FaceBox[] | undefined> {
  const lm = await load();
  if (!lm) return undefined;
  const bmp = await createImageBitmap(blob, { resizeWidth: 1024, resizeQuality: 'medium' });
  try {
    const res = lm.detect(bmp);
    return res.faceLandmarks.map((pts, i) => {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const p of pts) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      const shapes = new Map(res.faceBlendshapes[i]?.categories.map((c) => [c.categoryName, c.score]) ?? []);
      const g = (k: string) => shapes.get(k) ?? 0;
      return {
        x: Math.max(0, x0), y: Math.max(0, y0), w: Math.min(1, x1) - Math.max(0, x0), h: Math.min(1, y1) - Math.max(0, y0),
        eyesClosed: (g('eyeBlinkLeft') + g('eyeBlinkRight')) / 2,
        smile: (g('mouthSmileLeft') + g('mouthSmileRight')) / 2,
      };
    });
  } finally {
    bmp.close();
  }
}
