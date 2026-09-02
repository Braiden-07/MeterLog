/**
 * Contracts shared between the API and the web app.
 *
 * Zod schemas live here so a single definition validates on both sides
 * (PROJECT_BRIEF §3). The API additionally validates with class-validator DTOs
 * at the HTTP boundary; these are the shape, not a replacement for that.
 *
 * Entity schemas arrive with their modules from build-order step 4 onward.
 */
import { z } from 'zod';

/** Error envelope from PROJECT_BRIEF §6. Every non-2xx response takes this shape. */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** The three roles from PROJECT_BRIEF §2. */
export const roleSchema = z.enum(['admin', 'technician', 'auditor']);
export type Role = z.infer<typeof roleSchema>;
