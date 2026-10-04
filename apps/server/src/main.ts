import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import sharp from 'sharp';
import { PAGE_LAYOUTS } from '@care-agent/schema';
import { createApp } from './app';
import { applyCalibration, loadCalibration } from './calibration';
import { openAiCompatModel } from './chat-llm';
import { seedUsers } from './auth';
import { dataDirFromEnv, openDb } from './db';
import { pageSchemaFor } from './fields';
import { openOriginals } from './originals';
import { EventStore } from './stream';
import { createWorker, AnalysisError, type Analyzer } from './worker';
import { analyzePage } from './vision/analyze';
import { defaultDeps, loadCellBoxes, repoRoot } from './cli/pages';
import { inkOnlyFields } from './vision/manual';
import { modelConfig } from './vision/model';
import { rectify } from './vision/rectify';

const dataDir = dataDirFromEnv();
const db = openDb(dataDir);
const originals = openOriginals(dataDir);
const events = new EventStore(db);

const pins = seedUsers(db, dataDir);
if (pins.length) {
  console.log('Demo users created. PINs are shown ONCE (stored hashed):');
  for (const p of pins) console.log(`  ${p.id}  ${p.pin}`);
}

// ANALYZER=off skips the analysis (pages stay PENDING_AI): used to try the API without Ollama.
// ANALYZER=ink never calls the model: pages go straight to manual entry (ink-only reading).
const mode = process.env.ANALYZER;
const analyzerOn = mode !== 'off' && mode !== 'ink';

/** Decodes and rectifies the image and returns the schema + page of a page type, or fails like the analysis does. */
async function decode(image: Buffer, pageType: number) {
  const schema = pageSchemaFor(pageType);
  const layout = PAGE_LAYOUTS.find((l) => l === schema?.layout);
  if (!schema || !layout) throw new AnalysisError('page_type_unsupported'); // a page type outside 1 to 8
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // rectified in memory before reading; the stored original is never touched
  return { layout, schema, page: await rectify({ data, width: info.width, height: info.height }) };
}

// Calibration table (make calibrate): loaded once; refused with a log line when it was fitted on another pipeline.
const calibration = analyzerOn ? loadCalibration(`${dataDir}/calibration/table.json`) : undefined;

const analyzer: Analyzer | undefined = analyzerOn
  ? async (image, pageType) => {
      const { layout, schema, page } = await decode(image, pageType);
      const result = await analyzePage(page, layout, defaultDeps(layout));
      return applyCalibration(calibration, schema, result.fields.map((f) => ({ ...f, source_page: pageType }))); // pages 7 and 8 share the layout of 5 and 6
    }
  : undefined;
const inkAnalyzer: Analyzer = async (image, pageType) => {
  const { layout, schema, page } = await decode(image, pageType);
  return inkOnlyFields(page, schema, loadCellBoxes(layout)).map((f) => ({ ...f, source_page: pageType }));
};

const worker = createWorker({ db, originals, events }, analyzer, inkAnalyzer);
const root = new Hono();
root.use(logger()); // method, path (ids only), status: never bodies
// CHAT_ENGINE=strands: LLM chat engine (tool loop on Ollama's /v1); the deterministic parser is the default.
const chatModel = process.env.CHAT_ENGINE === 'strands' ? openAiCompatModel() : undefined;
// Synthetic reference dataset of the challenge (read-only, outside the repo): the dashboard shows it next to the live records.
const referenceCsv = resolve(repoRoot, process.env.DATASETS_DIR ?? '../datasets', 'data/maternal_registry_synthetic.csv');
root.route('/', createApp({ db, originals, events, worker, model: analyzerOn ? modelConfig().model : null, inkOnly: mode === 'ink', chatModel, referenceCsv }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: root.fetch, port, hostname: '0.0.0.0' }, () => console.log(`care-agent server on :${port} (data: ${dataDir}, analyzer ${mode === 'ink' ? 'ink' : analyzerOn ? 'on' : 'off'})`));
worker.resume();
