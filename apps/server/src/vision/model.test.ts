import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelError, ollamaModel, type ModelConfig } from './model';

const req = { prompt: 'p', image: Buffer.from('png'), format: {} };
const cfg = (fetchImpl: typeof fetch): ModelConfig => ({ url: 'http://x', model: 'm', timeoutMs: 1000, fetch: fetchImpl });
const kindOf = (fetchImpl: typeof fetch) => ollamaModel(cfg(fetchImpl))(req).then(() => 'ok', (e: ModelError) => e.kind);

test('maps an Ollama response', async () => {
  let body: any;
  const fake = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ message: { content: '{"cells":[]}' }, logprobs: [{ token: '{', logprob: -1, top_logprobs: [] }], prompt_eval_count: 7, prompt_eval_duration: 2e9, eval_count: 3, eval_duration: 1e9 }));
  }) as unknown as typeof fetch;
  const r = await ollamaModel(cfg(fake))(req);
  assert.deepEqual(r.timings, { prompt_tokens: 7, prefill_s: 2, output_tokens: 3, gen_s: 1 });
  assert.deepEqual(r.logprobs, [{ token: '{', logprob: -1 }]);
  assert.equal(body.think, false);
  assert.equal(body.messages[0].images[0], Buffer.from('png').toString('base64'));
});

test('typed errors: unreachable, http, timeout', async () => {
  assert.equal(await kindOf((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch), 'unreachable');
  assert.equal(await kindOf((async () => new Response('boom', { status: 500 })) as unknown as typeof fetch), 'http');
  assert.equal(await kindOf((async () => { throw new DOMException('timed out', 'TimeoutError'); }) as unknown as typeof fetch), 'timeout');
});
