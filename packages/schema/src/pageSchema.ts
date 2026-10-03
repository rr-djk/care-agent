import { z } from 'zod';
import { FieldDef } from './field';
import { PageType } from './page';

/** [x0, y0, x1, y1] as fractions of the page. */
export const BBoxFrac = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type BBoxFrac = z.infer<typeof BBoxFrac>;

/** One zone = one model call. `cells` are field ids in the order of `ZoneAnswer.cells`. */
export const ZoneDef = z.object({
  id: z.string(),
  bbox_frac: BBoxFrac,
  label_strip: BBoxFrac.optional(), // row-label strip to prepend when the zone crop has no row labels
  rows: z.array(z.string()).optional(), // table zones: printed row labels; cells are row-major rows x columns
  columns: z.array(z.string()).optional(),
  cells: z.array(z.string()),
});
export type ZoneDef = z.infer<typeof ZoneDef>;

// `applicability` of a FieldDef is "<field id> = <value>" (the field is NOT_APPLICABLE otherwise).
export const PageSchema = z.object({
  layout: z.string(),
  page_types: z.array(PageType),
  fields: z.array(FieldDef),
  zones: z.array(ZoneDef),
  masks: z.array(BBoxFrac), // identifier rectangles to blank before any crop leaves the device
});
export type PageSchema = z.infer<typeof PageSchema>;

export const PAGE_LAYOUTS = ['cover', 'identification', 'pregnancy', 'delivery'] as const;
export type PageLayout = (typeof PAGE_LAYOUTS)[number];
