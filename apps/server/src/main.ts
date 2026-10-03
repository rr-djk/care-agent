import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import sharp from 'sharp';
import { LAYOUT, PAGE_LAYOUTS } from '@care-agent/schema';
import { createApp } from './app';
import { seedUsers } from './auth';
import { dataDirFromEnv, openDb } from './db';
import { openOriginals } from './originals';
import { EventStore } from './stream';
import { createWorker, AnalysisError, type Analyzer } from './worker';
import { analyzePage } from './vision/analyze';
import { defaultDeps } from './cli/pages';
import { modelConfig } from './vision/model';

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
const analyzerOn = process.env.ANALYZER !== 'off';
const analyzer: Analyzer | undefined = analyzerOn
  ? async (image, pageType) => {
      const layout = PAGE_LAYOUTS.find((l) => l === LAYOUT[pageType as keyof typeof LAYOUT]);
      if (!layout) throw new AnalysisError('page_type_unsupported'); // e.g. the cover has no schema yet
      const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const result = await analyzePage({ data, width: info.width, height: info.height }, layout, defaultDeps(layout));
      return result.fields;
    }
  : undefined;

const worker = createWorker({ db, originals, events }, analyzer);
const root = new Hono();
root.use(logger()); // method, path (ids only), status: never bodies
root.route('/', createApp({ db, originals, events, worker, model: analyzerOn ? modelConfig().model : null }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: root.fetch, port, hostname: '0.0.0.0' }, () => console.log(`care-agent server on :${port} (data: ${dataDir}, analyzer ${analyzerOn ? 'on' : 'off'})`));
worker.resume();
