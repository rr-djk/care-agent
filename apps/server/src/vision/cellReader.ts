// Per-cell reader switch (experiment, docs/cell-reader.md). READER=gemma (default) = the zone prompts on Ollama, unchanged;
// READER=cell = every inked text cell read by PaddleOCR (readers/), no Ollama; READER=hybrid = PaddleOCR first, Gemma
// only on the cells below the confidence threshold (agree -> kept, disagree -> NEEDS_REVIEW).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FieldDef } from '@care-agent/schema';
import type { PageImage } from './ink';
import { INK_CROP, prepCrop } from './readers/common';
import { greedy, readField } from './readers/ctc';
import { paddleReader, type PaddleReader } from './readers/paddle';
import { readerScore, readerSignals } from './readers/score';

export type ReaderMode = 'gemma' | 'cell' | 'hybrid';

/** READER from the environment; an unknown value is an error, not a silent fallback. */
export function readerMode(value = process.env.READER): ReaderMode {
  if (value === undefined || value === '' || value === 'gemma') return 'gemma';
  if (value === 'cell' || value === 'hybrid') return value;
  throw new Error(`READER must be gemma, cell or hybrid, got "${value}"`);
}

/** Below this score a KNOWN reading goes to review (fitted on the clean tune pages, specimen fonts: docs/cell-reader.md). */
export const READER_THRESHOLD = 0.84;
/** Ink crop of a cell: box widened by this many px before cutting to the ink (readers/common.ts inkTrimCrop). */
export const CELL_EXPAND_PX = 4;

const MODEL = 'PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx';
const modelDir = () => resolve(process.env.MODELS_DIR ?? resolve(import.meta.dirname, '../../../../models'), MODEL);

export interface CellReading {
  text: string;
  score: number; // readers/score.ts, in [0, 1]
}

export interface CellReader {
  /** Reads one cell crop (raw RGB, cut from the MASKED page) under its field's type. */
  read(crop: PageImage, field: FieldDef): Promise<CellReading>;
}

/** PaddleOCR reader, loaded on first use (one ONNX session for the process). */
export function lazyPaddleReader(dir = modelDir()): CellReader {
  let session: Promise<PaddleReader> | undefined;
  return {
    async read(crop, field) {
      session ??= paddleReader(dir).catch((e) => {
        session = undefined;
        throw new Error(`cell reader model missing or unreadable in ${dir} (run: node tools/eval/fetch-cell-models.mjs): ${e instanceof Error ? e.message : e}`);
      });
      const frames = await (await session).frames(prepCrop(crop, 'stretch'));
      const g = greedy(frames);
      const r = readField(frames, field);
      return { text: r.text, score: readerScore(readerSignals({ text: r.text, steps: g.steps, logp: r.logp, logp_free: r.logp_free, rank: r.rank, runner_up: r.runner_up, posterior: r.posterior }, field)) };
    },
  };
}

let shared: CellReader | undefined;
/** One reader (one ONNX session) for the whole process. */
export const sharedCellReader = () => (shared ??= lazyPaddleReader());

let identityCache: { dir: string; sha: string } | undefined;
/**
 * What the pipeline hash must add when the cell reader is on: mode, model file, threshold and crop. undefined for
 * READER=gemma, so the hash (and every calibration table made for it) stays exactly as before.
 */
export function readerIdentity(mode = readerMode()): object | undefined {
  if (mode === 'gemma') return undefined;
  const dir = modelDir();
  if (identityCache?.dir !== dir) identityCache = { dir, sha: createHash('sha256').update(readFileSync(`${dir}/inference.onnx`)).digest('hex') };
  return { reader: mode, model: MODEL, model_sha256: identityCache.sha, threshold: READER_THRESHOLD, expand_px: CELL_EXPAND_PX, crop: INK_CROP, prep: 'stretch' };
}
