import { describe, expect, it } from 'vitest';
import { readEvents } from './ndjson';

function streamOf(...chunks: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const e of readEvents(body)) out.push(e);
  return out;
}

describe('readEvents', () => {
  it('reassembles lines split across chunks', async () => {
    const events = await collect(streamOf('{"type":"page_rec', 'eived","page_id":"a"}\n{"type":"record_', 'ready","record_id":"s"}\n'));
    expect(events).toEqual([
      { type: 'page_received', page_id: 'a' },
      { type: 'record_ready', record_id: 's' },
    ]);
  });

  it('parses a last line without trailing newline', async () => {
    expect(await collect(streamOf('{"type":"record_ready","record_id":"s"}'))).toEqual([{ type: 'record_ready', record_id: 's' }]);
  });

  it('ignores pings', async () => {
    expect(await collect(streamOf('{"type":"ping"}\n{"type":"ping"}\n'))).toEqual([]);
  });

  it('turns a bad line into an error event and keeps reading', async () => {
    const events = await collect(streamOf('not json\n{"type":"nope"}\n{"type":"record_ready","record_id":"s"}\n'));
    expect(events.map((e) => e.type)).toEqual(['error', 'error', 'record_ready']);
    expect(events[0]).toMatchObject({ type: 'error', code: 'bad_event' });
  });
});
