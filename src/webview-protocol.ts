import { z } from 'zod';

const index = z.number().int().nonnegative();
const cell = z.object({ row: index, col: index, value: z.string() });
const selection = z.object({
  minRow: index,
  maxRow: index,
  minCol: index,
  maxCol: index,
  rectangular: z.boolean()
}).optional();

export const webviewMessageSchema = z.discriminatedUnion('type', [
  cell.extend({ type: z.literal('editCell') }),
  z.object({ type: z.literal('replaceCells'), replacements: z.array(cell).max(1_000_000) }),
  z.object({ type: z.literal('pasteCells'), text: z.string(), anchorRow: index, anchorCol: index, selection }),
  z.object({ type: z.literal('requestChunk'), start: index, requestId: z.number().int() }),
  z.object({ type: z.literal('findMatches'), requestId: z.number().int(), query: z.string(), options: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal('save') }),
  z.object({ type: z.literal('copyToClipboard'), text: z.string().max(100_000_000) }),
  z.object({ type: z.enum(['insertColumn', 'deleteColumn', 'insertRow', 'deleteRow']), index }),
  z.object({ type: z.enum(['insertColumns', 'insertRows']), index, count: index.max(100_000) }),
  z.object({ type: z.enum(['deleteColumns', 'deleteRows']), indices: z.array(index).max(100_000) }),
  z.object({ type: z.enum(['reorderColumns', 'reorderRows']), indices: z.array(index).max(100_000), beforeIndex: index }),
  z.object({ type: z.literal('sortColumn'), index, ascending: z.boolean() }),
  z.object({ type: z.literal('openLink'), url: z.string().url().max(16_384) }),
  z.object({
    type: z.enum(['previewDataTool', 'applyDataTool']),
    request: z.object({
      action: z.enum(['trim', 'uppercase', 'lowercase', 'fillEmpty', 'removeEmptyRows', 'removeDuplicates']),
      columns: z.array(index).optional(),
      value: z.string().optional()
    })
  }),
  z.object({ type: z.enum(['validateData', 'openTextView', 'undo', 'redo', 'cycleTheme']) })
]);

export type WebviewMessage = z.infer<typeof webviewMessageSchema>;

export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  const parsed = webviewMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
