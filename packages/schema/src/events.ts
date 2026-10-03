import { z } from 'zod';
import { ExtractedField } from './field';

// One JSON object per line (NDJSON) on /api/chat and /api/sessions/:id/analysis.
export const ChatEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), text: z.string() }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), code: z.string(), text: z.string(), page_id: z.string().optional() }),
]);

export const AnalysisEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page_received'), page_id: z.string() }),
  z.object({ type: z.literal('page_read'), page_id: z.string(), fields: z.array(ExtractedField) }),
  z.object({ type: z.literal('field_flagged'), page_id: z.string(), field_id: z.string(), reason: z.string() }),
  z.object({ type: z.literal('record_ready'), record_id: z.string() }),
]);

export const StreamEvent = z.discriminatedUnion('type', [...ChatEvent.options, ...AnalysisEvent.options]);
export type StreamEvent = z.infer<typeof StreamEvent>;

/** Parses one NDJSON line; throws on invalid JSON or unknown/malformed event. */
export function parseEvent(line: string): StreamEvent {
  return StreamEvent.parse(JSON.parse(line));
}
