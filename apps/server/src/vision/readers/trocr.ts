// TrOCR (handwritten, IAM) via @huggingface/transformers, offline from models/<repo> (tools/eval/fetch-cell-models.mjs).
// Greedy decoding; transformers.js returns no scores, so a logits processor records each step's distribution.
import { AutoProcessor, AutoTokenizer, env, LogitsProcessor, RawImage, VisionEncoderDecoderModel } from '@huggingface/transformers';
import type { PageImage } from '../ink';
import type { CellReader, CellReading, ReadingStep } from './common';

interface Step {
  id: number;
  p: number;
  id2: number;
  p2: number;
}

/** Records softmax top-2 per decoding step; with `allowedIds`, every other token gets -Infinity first. */
class StepRecorder extends LogitsProcessor {
  steps: Step[] = [];
  allowedIds?: Uint8Array;
  _call(_inputIds: bigint[][], logits: any) {
    const row = logits[0].data as Float32Array;
    if (this.allowedIds) for (let k = 0; k < row.length; k++) if (!this.allowedIds[k]) row[k] = -Infinity;
    let max = -Infinity;
    for (const v of row) if (v > max) max = v;
    let sum = 0, b1 = 0, b2 = 0;
    for (let k = 0; k < row.length; k++) {
      sum += Math.exp(row[k] - max);
      if (row[k] > row[b1]) [b2, b1] = [b1, k];
      else if (k !== b1 && row[k] > row[b2]) b2 = k;
    }
    this.steps.push({ id: b1, p: Math.exp(row[b1] - max) / sum, id2: b2, p2: Math.exp(row[b2] - max) / sum });
    return logits;
  }
}

export async function trocrReader(modelsDir: string, repo = 'Xenova/trocr-small-handwritten', dtype: 'fp32' | 'q8' = 'fp32'): Promise<CellReader> {
  env.localModelPath = modelsDir.endsWith('/') ? modelsDir : `${modelsDir}/`;
  env.allowRemoteModels = false;
  const processor = await AutoProcessor.from_pretrained(repo);
  const tokenizer = await AutoTokenizer.from_pretrained(repo);
  const model: any = await VisionEncoderDecoderModel.from_pretrained(repo, { dtype, device: 'cpu' });
  const eos = Number(model.generation_config?.eos_token_id ?? model.config.decoder?.eos_token_id ?? 2);
  const tokenText = (id: number) => tokenizer.decode([id], { skip_special_tokens: true });
  // token ids whose decoded text uses only characters of an alphabet (phase 2), cached per alphabet
  const vocabSize = Number(model.config.decoder?.vocab_size ?? model.config.vocab_size);
  const masks = new Map<string, Uint8Array>();
  const allowedIds = (alphabet: string) => {
    let m = masks.get(alphabet);
    if (!m) {
      m = new Uint8Array(vocabSize);
      for (let id = 0; id < vocabSize; id++) {
        const t = tokenText(id);
        m[id] = +(id === eos || (t.length > 0 && [...t].every((c) => alphabet.includes(c))));
      }
      masks.set(alphabet, m);
    }
    return m;
  };
  return {
    name: `trocr-small-handwritten-${dtype}`,
    async read(crop: PageImage, opts = {}): Promise<CellReading> {
      const t0 = performance.now();
      const image = new RawImage(new Uint8ClampedArray(crop.data.buffer, crop.data.byteOffset, crop.data.length), crop.width, crop.height, 3);
      const { pixel_values } = await (processor as any)(image);
      const rec = new StepRecorder();
      if (opts.allowed !== undefined) rec.allowedIds = allowedIds(opts.allowed);
      const out = await model.generate({ inputs: pixel_values, max_new_tokens: 32, logits_processor: [rec] });
      const ids = (out.tolist()[0] as bigint[]).slice(1).map(Number); // drop the decoder start token
      const steps: ReadingStep[] = rec.steps
        .slice(0, ids.length)
        .filter((s) => s.id !== eos)
        .map((s) => ({ text: tokenText(s.id), p: s.p, alt: s.id2 === eos ? '∅' : tokenText(s.id2), p_alt: s.p2 }));
      const text = tokenizer.decode(ids, { skip_special_tokens: true }).trim();
      const seq = rec.steps.slice(0, ids.length).reduce((a, s) => a + Math.log(Math.max(s.p, 1e-12)), 0);
      return { text, steps, seq_logprob: seq, ms: performance.now() - t0 };
    },
  };
}
