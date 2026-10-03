#!/usr/bin/env node
// Latency probe for a local OpenAI-compatible runtime. Zero dependencies. See README.md.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const BASE_URL = (env.BASE_URL || 'http://localhost:11434/v1').replace(/\/$/, '');
const MODEL = env.MODEL;
const CROP = env.CROP || join(here, 'out', 'p03_crop.png');
const BUDGETS = (env.BUDGETS || '560,1120').split(',').map((s) => s.trim()).filter(Boolean);

if (!MODEL) {
  console.error('MODEL is required, e.g. MODEL=gemma4:e4b node tools/smoke/probe.mjs');
  console.error('List models: `ollama list` (Ollama) or GET <BASE_URL>/models. Optional: BASE_URL, API_KEY, RUNTIME_PROC, EXTRA_BODY, BUDGETS.');
  process.exit(1);
}

const jsonEnv = (name) => {
  if (!env[name]) return {};
  try { return JSON.parse(env[name]); } catch { console.error(`${name} is not valid JSON`); process.exit(1); }
};
const extraBody = jsonEnv('EXTRA_BODY');

let imageUrl;
try {
  imageUrl = `data:image/png;base64,${readFileSync(CROP).toString('base64')}`;
} catch {
  console.error(`crop not found: ${CROP}. Run: python3 tools/smoke/crop.py`);
  process.exit(1);
}

const PROMPT = 'Transcribe verbatim the handwritten values of this zone of a maternal registry table. ' +
  'Return only JSON: {"fields":[{"row":"<row label>","verbatim":"<handwritten text>","legible":true|false}]}';

const SCHEMA = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: { row: { type: 'string' }, verbatim: { type: 'string' }, legible: { type: 'boolean' } },
        required: ['row', 'verbatim', 'legible'],
      },
    },
  },
  required: ['fields'],
};

const headers = { 'content-type': 'application/json', ...(env.API_KEY ? { authorization: `Bearer ${env.API_KEY}` } : {}) };

const rssMB = () => {
  if (!env.RUNTIME_PROC) return null;
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-C', env.RUNTIME_PROC], { encoding: 'utf8' });
    const kb = out.split('\n').map((l) => parseInt(l, 10)).filter(Number.isFinite).reduce((a, b) => a + b, 0);
    return kb ? Math.round(kb / 1024) : null;
  } catch { return null; }
};

const parses = (text) => {
  // Tolerate a markdown fence around the JSON.
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t) !== null; } catch { return false; }
};

class Unreachable extends Error {}

async function request(extra, { stream = true } = {}) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: imageUrl } }, // image before text
      { type: 'text', text: PROMPT },
    ] }],
    temperature: 0,
    max_tokens: 512,
    // Thinking off where supported: Ollama honours `think`, llama.cpp/LM Studio ignore unknown keys.
    think: false,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...extraBody,
    ...extra,
  };
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Unreachable(e.cause?.code || e.message);
  }
  if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 300), totalS: (performance.now() - t0) / 1000 };

  let text = '', ttftS = null, usage = null, logprobs = false;
  if (!stream) {
    const j = await res.json();
    text = j.choices?.[0]?.message?.content ?? '';
    usage = j.usage ?? null;
    logprobs = Boolean(j.choices?.[0]?.logprobs?.content?.length);
  } else {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) { ttftS ??= (performance.now() - t0) / 1000; text += delta; }
        if (j.choices?.[0]?.logprobs?.content?.length) logprobs = true;
        if (j.usage) usage = j.usage;
      }
    }
  }
  const totalS = (performance.now() - t0) / 1000;
  const completion = usage?.completion_tokens ?? null;
  return {
    ok: true, totalS, ttftS, usage, logprobs, validJson: parses(text), text,
    tokensPerS: completion && totalS > (ttftS ?? 0) ? completion / (totalS - (ttftS ?? 0)) : null,
  };
}

const f = (n, d = 1) => (n == null ? 'n/a' : n.toFixed(d));
const results = { baseUrl: BASE_URL, model: MODEL, date: new Date().toISOString(), budgets: [], logprobs: null, jsonSchema: null };

try {
  for (const label of BUDGETS) {
    const extra = jsonEnv(`EXTRA_BODY_${label}`);
    const rssBefore = rssMB();
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const r = await request(extra);
      runs.push({ kind: i === 0 ? 'cold' : 'warm', ...r });
      console.error(`budget ${label} ${runs.at(-1).kind}: ${r.ok ? f(r.totalS) + ' s' : 'HTTP ' + r.status + ' ' + r.error}`);
    }
    results.budgets.push({ label, extra, rssBeforeMB: rssBefore, rssAfterMB: rssMB(), runs });
  }

  const lp = await request({ logprobs: true, top_logprobs: 1 }, { stream: false });
  results.logprobs = { accepted: lp.ok, returned: Boolean(lp.logprobs), error: lp.error };
  const js = await request({
    response_format: { type: 'json_schema', json_schema: { name: 'zone', strict: true, schema: SCHEMA } },
  }, { stream: false });
  results.jsonSchema = { accepted: js.ok, validJson: Boolean(js.validJson), error: js.error };
} catch (e) {
  if (e instanceof Unreachable) {
    console.error(`Cannot reach the runtime at ${BASE_URL} (${e.message}). Is it running? Start Ollama/llama.cpp/LM Studio or set BASE_URL.`);
    process.exit(2);
  }
  throw e;
}

mkdirSync(join(here, 'out'), { recursive: true });
writeFileSync(join(here, 'out', 'results.json'), JSON.stringify(results, null, 2));

console.log(`\nModel \`${MODEL}\` at ${BASE_URL}\n`);
console.log('| budget | run | total s | TTFT s | tok/s | JSON ok | RSS before/after MB |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const b of results.budgets) {
  b.runs.forEach((r, i) => {
    const rss = i === 0 ? `${b.rssBeforeMB ?? 'n/a'} / ${b.rssAfterMB ?? 'n/a'}` : '';
    console.log(`| ${b.label} | ${r.kind} | ${f(r.totalS)} | ${f(r.ttftS)} | ${f(r.tokensPerS)} | ${r.ok ? r.validJson : 'HTTP ' + r.status} | ${rss} |`);
  });
}
console.log(`\nlogprobs: accepted=${results.logprobs.accepted} returned=${results.logprobs.returned}`);
console.log(`json_schema: accepted=${results.jsonSchema.accepted} valid_json=${results.jsonSchema.validJson}`);
console.log('\nNote: budget labels are only recorded unless EXTRA_BODY_<label> is set; the visual token budget parameter is runtime-specific and unverified.');
console.log('Raw results: tools/smoke/out/results.json');
