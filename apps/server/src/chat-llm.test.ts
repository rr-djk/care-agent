import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openAiCompatModel, runToolAgent, type ChatMessage, type ChatModelFn, type ToolHost } from './chat-llm';
import type { ExtractedField } from '@care-agent/schema';

const call = (name: string, args: object): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'c1', function: { name, arguments: JSON.stringify(args) } }],
});
const say = (content: string): ChatMessage => ({ role: 'assistant', content });

function setup(script: ChatMessage[]) {
  const applied: unknown[] = [];
  const seen: ChatMessage[][] = [];
  let i = 0;
  const model: ChatModelFn = async (messages) => (seen.push(structuredClone(messages)), script[i++]);
  const host: ToolHost = {
    pageId: 'page-A',
    fieldIds: new Set(['p03.taille']),
    pending: () => [],
    apply: (fieldId, edit) => (applied.push([fieldId, edit]), { field_id: fieldId, value: '158', status: 'KNOWN' } as ExtractedField),
    startManual: async () => {},
  };
  const lastTool = () => JSON.parse(seen[seen.length - 1].filter((m) => m.role === 'tool').at(-1)!.content!);
  return { model, host, applied, lastTool };
}

test('tools run the shared code on the bound page', async () => {
  const t = setup([call('apply_correction', { field_id: 'p03.taille', value: '158' }), say('Taille enregistrée.')]);
  assert.equal(await runToolAgent(t.model, t.host, '158'), 'Taille enregistrée.');
  assert.deepEqual(t.applied, [['p03.taille', { value: '158' }]]);
  assert.deepEqual(t.lastTool(), { status: 'KNOWN', value: '158' });
});

test('a tool call aimed at another record is refused and changes nothing', async () => {
  for (const args of [
    { field_id: 'p03.taille', value: '1', page_id: 'page-B' }, // another page
    { field_id: 'p03.taille', value: '1', session_id: 'other' }, // a session id is never accepted
    { field_id: 'p03.ddr', value: '1' }, // a field that is not on the bound page
  ]) {
    const t = setup([call('apply_correction', args), say('Refusé.')]);
    await runToolAgent(t.model, t.host, 'x');
    assert.deepEqual(t.applied, []);
    assert.deepEqual(t.lastTool(), { error: 'out_of_scope' });
  }
  const bad = setup([call('confirm_field', { nope: 1 }), say('?')]);
  await runToolAgent(bad.model, bad.host, 'x');
  assert.deepEqual(bad.lastTool(), { error: 'bad_arguments' });
  assert.deepEqual(bad.applied, []);
});

test('the loop is bounded', async () => {
  const t = setup(Array(10).fill(call('get_pending_fields', {})));
  assert.match(await runToolAgent(t.model, t.host, 'x'), /boutons/);
});

test('OpenAI-compatible request: /v1 endpoint, reasoning_effort none, model from config', async () => {
  let url = '';
  let body: any;
  const fakeFetch = (async (u: string, init: RequestInit) => {
    url = u;
    body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Bonjour' } }] }));
  }) as unknown as typeof fetch;
  const model = openAiCompatModel({ url: 'http://ollama:11434', model: 'm', timeoutMs: 1000, fetch: fakeFetch }, 'chat-model');
  assert.equal((await model([{ role: 'user', content: 'x' }], [])).content, 'Bonjour');
  assert.equal(url, 'http://ollama:11434/v1/chat/completions');
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.model, 'chat-model');
});
