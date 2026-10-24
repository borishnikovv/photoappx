// Copies MediaPipe's wasm runtime into public/ so face analysis works offline after first load.
import { cpSync, existsSync } from 'node:fs';
const src = 'node_modules/@mediapipe/tasks-vision/wasm';
if (existsSync(src)) cpSync(src, 'public/mediapipe-wasm', { recursive: true });
