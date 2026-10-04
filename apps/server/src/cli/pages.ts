// Page lookup shared by the CLIs: page_no -> PNG under DATASETS_DIR (read-only), layout from pages.json.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { PAGE_LAYOUTS, REAL_LAYOUTS, type PageLayout } from '@care-agent/schema';
import type { AnalyzeDeps, CellBox } from '../vision/analyze';
import { fileCache } from '../vision/cache';
import type { PageImage } from '../vision/ink';
import { modelConfig, ollamaModel } from '../vision/model';
import { rectify } from '../vision/rectify';

export const repoRoot = resolve(import.meta.dirname, '../../../..');
const datasetsDir = () => resolve(repoRoot, process.env.DATASETS_DIR ?? '../datasets');

interface PageEntry {
  page_no: number;
  page_type: number;
  patient: number;
  files: string[];
}
export const pageEntries: PageEntry[] = JSON.parse(readFileSync(`${repoRoot}/tools/eval/data/pages.json`, 'utf8')).pages;
const groundTruth = () => JSON.parse(readFileSync(`${repoRoot}/tools/eval/data/ground_truth.json`, 'utf8'));

/** A photo of the real registry (1-1.jpg ...), read-only under DATASETS_DIR. */
export const realPhotoPath = (name: string) => resolve(datasetsDir(), 'data/Paper Registry', `${name}.jpg`);

export function pagePngPath(pageNo: number): string {
  const entry = pageEntries.find((p) => p.page_no === pageNo);
  if (!entry) throw new Error(`unknown page_no ${pageNo}`);
  return resolve(datasetsDir(), 'data/Paper Registry', entry.files[0]);
}

/** Layout of a page_no from the ground truth (undefined for page types without a schema). */
export function pageLayout(pageNo: number): PageLayout | undefined {
  const layout = groundTruth()[pageNo]?.layout;
  return (PAGE_LAYOUTS as readonly string[]).includes(layout) ? layout : undefined;
}

/** Cell boxes by field id, from the layout template (tools/eval/data/zones; the page schema has zone boxes only). */
export function loadCellBoxes(layout: PageLayout): Map<string, CellBox> {
  const file = JSON.parse(readFileSync(`${repoRoot}/tools/eval/data/zones/${layout}.json`, 'utf8'));
  return new Map(file.zones.flatMap((z: { cells: (CellBox & { key: string })[] }) => z.cells.map((c) => [c.key, c] as const)));
}

export async function loadPageImage(path: string): Promise<PageImage> {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** The image a layout is read on: photos of the real form are warped to the template size first, like the server does. */
export async function loadLayoutImage(path: string, layout: PageLayout): Promise<PageImage> {
  const page = await loadPageImage(path);
  return (REAL_LAYOUTS as readonly string[]).includes(layout) ? rectify(page) : page;
}

/** Ollama model, file cache under data/cache and the cell boxes of the layout. */
export function defaultDeps(layout: PageLayout): AnalyzeDeps {
  const cfg = modelConfig();
  return { model: ollamaModel(cfg), modelName: cfg.model, cache: fileCache(`${repoRoot}/data/cache`), cellBoxes: loadCellBoxes(layout) };
}
