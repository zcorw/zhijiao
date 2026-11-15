import { z } from 'zod';

export const interactionAnalysisProviderSchema = z.enum(['deepseek', 'openai']);
export type InteractionAnalysisProvider = z.infer<typeof interactionAnalysisProviderSchema>;

export const interactionAnalysisStatusSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false) }),
  z.object({ available: z.literal(true), provider: interactionAnalysisProviderSchema, providerLabel: z.string().min(1) }),
]);
export type InteractionAnalysisStatus = z.infer<typeof interactionAnalysisStatusSchema>;

export const interactionAnalysisSettingsSchema = z.object({
  provider: interactionAnalysisProviderSchema.nullable(),
  preferredProvider: interactionAnalysisProviderSchema.nullable(),
  defaultProvider: interactionAnalysisProviderSchema.nullable(),
  providers: z.array(z.object({ id: interactionAnalysisProviderSchema, model: z.string().min(1).nullable() })),
});
export type InteractionAnalysisSettings = z.infer<typeof interactionAnalysisSettingsSchema>;

export const interactionAnalysisSettingsUpdateSchema = z.strictObject({ provider: interactionAnalysisProviderSchema.nullable() });
