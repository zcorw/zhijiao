import { z } from 'zod';

export const analysisSourceSchema = z.strictObject({
  type: z.enum(['narrator', 'person', 'unknown', 'model']), personId: z.string().min(1).max(60).nullable(),
});
