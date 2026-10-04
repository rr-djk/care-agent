// PP-OCRv5 mobile Latin recogniser (CTC), ONNX via onnxruntime-node. Model: models/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx
// (tools/eval/fetch-cell-models.mjs). Input: BGR, height 48, (x/255 - 0.5) / 0.5, right-padded with 0 to at least 320 px.
// Output: per-frame probabilities over [blank, ...character_dict, ' '].
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import type { PageImage } from '../ink';
import type { CellReader, CellReading } from './common';
import { greedy, type Frames } from './ctc';

const H = 48;
const MIN_W = 320;

/** character_dict of inference.yml: one `  - x` line per character, single-quoted when YAML needs it. */
export function parseDict(yml: string): string[] {
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === 'character_dict:');
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^ {2}- (.*)$/.exec(l);
    if (!m) break;
    out.push(m[1].startsWith("'") ? m[1].slice(1, -1).replace(/''/g, "'") : m[1]);
  }
  return out;
}

export interface PaddleReader extends CellReader {
  /** Per-frame class probabilities of one crop, for the constrained decoders of ctc.ts (phase 2). */
  frames(crop: PageImage): Promise<Frames>;
}

export async function paddleReader(dir: string, name = 'paddle-latin-v5'): Promise<PaddleReader> {
  const session = await ort.InferenceSession.create(`${dir}/inference.onnx`, { logSeverityLevel: 3 });
  const classes = ['', ...parseDict(readFileSync(`${dir}/inference.yml`, 'utf8')), ' ']; // index 0 = CTC blank
  async function frames(crop: PageImage): Promise<Frames> {
    const w = Math.max(8, Math.min(1600, Math.round((H * crop.width) / crop.height)));
    const W = Math.max(MIN_W, w);
    const rgb = await sharp(crop.data, { raw: { width: crop.width, height: crop.height, channels: 3 } }).resize(w, H, { fit: 'fill' }).raw().toBuffer();
    const x = new Float32Array(3 * H * W); // padding = 0 after normalization
    for (let y = 0; y < H; y++) {
      for (let i = 0; i < w; i++) {
        const s = (y * w + i) * 3;
        for (let c = 0; c < 3; c++) x[c * H * W + y * W + i] = (rgb[s + 2 - c] / 255 - 0.5) / 0.5; // RGB -> BGR planes
      }
    }
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, H, W]) });
    const probs = out[session.outputNames[0]];
    const [, T, C] = probs.dims as number[];
    return { T, C, data: probs.data as Float32Array, classes };
  }
  return {
    name,
    frames,
    async read(crop: PageImage, opts = {}): Promise<CellReading> {
      const t0 = performance.now();
      const g = greedy(await frames(crop), opts.allowed);
      return { ...g, ms: performance.now() - t0 };
    },
  };
}
