import type { FieldDef, PageSchema } from '@care-agent/schema';

// Page schemas are bundled for their French labels (the node-only loader is not usable in the browser).
const schemas = import.meta.glob<PageSchema>('../../../packages/schema/pages/*.json', { eager: true, import: 'default' });

const defs = new Map<string, FieldDef>(Object.values(schemas).flatMap((s) => s.fields.map((f) => [f.id, f] as const)));

export const fieldDef = (id: string): FieldDef | undefined => defs.get(id);
export const fieldLabel = (id: string) => defs.get(id)?.label_fr ?? id;
