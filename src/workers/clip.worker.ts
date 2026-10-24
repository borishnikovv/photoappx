/// <reference lib="webworker" />
// Zero-shot "art director" built on CLIP, running fully in the browser via transformers.js.
// The model (~90 MB quantized) is downloaded once and cached by the browser.
import {
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
  env,
  type PreTrainedTokenizer,
  type Processor,
  type PreTrainedModel,
} from '@huggingface/transformers';

env.allowLocalModels = false;
const MODEL = 'Xenova/clip-vit-base-patch32';

/** What we want: documentary, candid, artful. */
const GOOD = [
  'a beautiful candid documentary photograph',
  'an artful fine art photograph with beautiful natural light',
  'a cinematic 35mm film photograph',
  'an editorial photograph with a striking composition',
  'a moody atmospheric photograph with soft light',
  'a candid portrait of a person laughing in natural light',
  'a minimalist photograph with negative space',
  'a quiet intimate moment captured candidly',
];

/** What an art director cuts. Index matters: the first few are hard rejects. */
const BAD = [
  'a screenshot of a phone screen',
  'a photo of a document, receipt, menu or whiteboard',
  'an accidental blurry photo of the floor or the inside of a pocket',
  'a meme or an image with lots of text',
  'a blurry out of focus photo',
  'a cheesy posed selfie with a peace sign',
  'a cliché generic stock photo',
  'a distorted wide angle selfie taken too close to the face',
  'a boring snapshot with a cluttered composition',
  'a photo with an ugly heavy filter',
  'a group photo of people posing and smiling at the camera',
];
const HARD_REJECT = new Set([0, 1, 2, 3]);
const BAD_LABELS = [
  'Screenshot', 'Document / receipt', 'Accidental shot', 'Text / meme', 'Out of focus', 'Cheesy pose',
  'Stock-photo cliché', 'Wide-angle distortion', 'Cluttered snapshot', 'Heavy filter', 'Posed group shot',
];

let ready: Promise<{ tok: PreTrainedTokenizer; proc: Processor; vision: PreTrainedModel; text: Float32Array[] }> | null = null;

function load() {
  ready ??= (async () => {
    const opts = { dtype: 'q8' as const, device: 'wasm' as const };
    const [tok, proc, textModel, vision] = await Promise.all([
      AutoTokenizer.from_pretrained(MODEL),
      AutoProcessor.from_pretrained(MODEL),
      CLIPTextModelWithProjection.from_pretrained(MODEL, opts),
      CLIPVisionModelWithProjection.from_pretrained(MODEL, {
        ...opts,
        progress_callback: (p: { status: string; progress?: number }) => {
          if (p.status === 'progress') ctx.postMessage({ type: 'progress', progress: p.progress });
        },
      }),
    ]);
    const inputs = tok([...GOOD, ...BAD], { padding: true, truncation: true });
    const { text_embeds } = await textModel(inputs);
    const dim = text_embeds.dims[1];
    const raw = text_embeds.data as Float32Array;
    const text = Array.from({ length: GOOD.length + BAD.length }, (_, i) => normalize(raw.slice(i * dim, (i + 1) * dim)));
    return { tok, proc, vision, text };
  })();
  return ready;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<{ type: 'init' } | { type: 'image'; id: string; blob: Blob }>) => {
  const msg = e.data;
  try {
    const m = await load();
    if (msg.type === 'init') return ctx.postMessage({ type: 'ready' });
    const image = await RawImage.fromBlob(msg.blob);
    const { image_embeds } = await m.vision(await m.proc(image));
    const emb = normalize(image_embeds.data as Float32Array);
    const sims = m.text.map((t) => 100 * dot(emb, t));
    const probs = softmax(sims);
    const good = probs.slice(0, GOOD.length).reduce((a, b) => a + b, 0);
    const badProbs = probs.slice(GOOD.length);
    const worst = badProbs.indexOf(Math.max(...badProbs));
    // Style: how documentary/candid vs. posed, independent of the junk classes.
    const style = softmax([sims[0], sims[5], sims[7], sims[GOOD.length + 5], sims[GOOD.length + 10]]);
    ctx.postMessage({
      type: 'result',
      id: msg.id,
      embedding: emb,
      aesthetic: good,
      style: style[0] + style[1] + style[2],
      flag: badProbs[worst] > 0.25 ? BAD_LABELS[worst] : undefined,
      hardReject: HARD_REJECT.has(worst) && badProbs[worst] > 0.35,
    });
  } catch (err) {
    ctx.postMessage({ type: 'error', id: 'id' in msg ? msg.id : undefined, error: String(err) });
  }
};

function normalize(v: Float32Array) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return v.map((x) => x / s);
}
function dot(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function softmax(xs: number[]) {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}
