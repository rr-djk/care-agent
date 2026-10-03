import { parseEvent, type StreamEvent } from '@care-agent/schema';

const badLine: StreamEvent = { type: 'error', code: 'bad_event', text: 'unreadable stream line' };

function parseLine(line: string): StreamEvent | null {
  if (!line.trim()) return null;
  try {
    const event = parseEvent(line);
    return event.type === 'ping' ? null : event;
  } catch {
    return badLine;
  }
}

/** Reads an NDJSON body line by line (lines may span chunks); pings are dropped, a bad line becomes an `error` event. `onActivity` runs on every chunk (idle watchdog). */
export async function* readEvents(body: ReadableStream<Uint8Array>, onActivity?: () => void): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      onActivity?.(); // pings are dropped below, but they still prove the connection is alive
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = done ? '' : lines.pop()!;
      for (const line of lines) {
        const event = parseLine(line);
        if (event) yield event;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
