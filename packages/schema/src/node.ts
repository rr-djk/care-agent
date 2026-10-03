// Node-only entry (`@care-agent/schema/node`): the loader reads files, the main entry stays browser-safe.
import { readFileSync } from 'node:fs';
import { PageSchema, type PageLayout } from './pageSchema';

/** Reads and validates packages/schema/pages/<layout>.json. */
export function loadPageSchema(layout: PageLayout): PageSchema {
  const file = new URL(`../pages/${layout}.json`, import.meta.url);
  return PageSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
