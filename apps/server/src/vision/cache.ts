import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelResponse } from './model';

export interface Cache {
  get(key: string): Promise<ModelResponse | undefined>;
  set(key: string, response: ModelResponse): Promise<void>;
}

/** sha256 of everything that determines the model answer. */
export const cacheKey = (crop: Buffer, prompt: string, format: object, model: string) =>
  createHash('sha256').update(crop).update(prompt).update(JSON.stringify(format)).update(model).digest('hex');

/** One JSON file per key under `dir` (data/cache, git-ignored). */
export function fileCache(dir: string): Cache {
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8'));
      } catch {
        return undefined;
      }
    },
    async set(key, response) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${key}.json`), JSON.stringify(response));
    },
  };
}
