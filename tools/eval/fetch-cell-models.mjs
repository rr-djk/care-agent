// Setup step for the cell-reader experiment (docs/cell-reader.md): downloads the candidate handwriting recognisers
// into models/ (git-ignored). Run once with network; the bench and the server then work offline.
// Usage: node tools/eval/fetch-cell-models.mjs
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../models');
const HF = 'https://huggingface.co';
const MODELS = [
  {
    // TrOCR-small handwritten (IAM), ONNX export by Xenova; fp32 and int8 so the bench can compare both
    repo: 'Xenova/trocr-small-handwritten',
    files: [
      'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json',
      'onnx/encoder_model.onnx', 'onnx/decoder_model_merged.onnx', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
    ],
  },
  {
    // PP-OCRv5 mobile Latin recogniser (CTC), official ONNX export; the character dictionary is in inference.yml
    repo: 'PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx',
    files: ['inference.onnx', 'inference.yml'],
  },
];

for (const { repo, files } of MODELS) {
  for (const file of files) {
    const out = resolve(root, repo, file);
    if (!existsSync(out)) {
      const res = await fetch(`${HF}/${repo}/resolve/main/${file}`);
      if (!res.ok) throw new Error(`${repo}/${file}: HTTP ${res.status}`);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, Buffer.from(await res.arrayBuffer()));
    }
    const buf = await readFile(out);
    console.log(`${createHash('sha256').update(buf).digest('hex').slice(0, 16)}  ${(buf.length / 1e6).toFixed(1).padStart(6)} MB  ${repo}/${file}`);
  }
}
