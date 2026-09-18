import { roleSchema } from '@meterlog/shared';
import { z } from 'zod';

/**
 * REQUEST-BODY SCHEMAS, DECLARED LOCALLY AND DELIBERATELY NOT SHARED.
 *
 * `@meterlog/shared` carries the error envelope and the role enum — contracts both
 * sides must agree on. These are not that. They are the CLIENT'S UX rules: they
 * decide what the form complains about before a request is sent.
 *
 * The server is the sole authority. `class-validator` DTOs run on every request
 * with `forbidNonWhitelisted`, so anything this file wrongly admits is refused
 * with a 400 that the form renders. That is why a mismatch here is a usability bug
 * rather than a security one — and why importing these from shared would be
 * actively misleading, implying one definition guards both sides when only the
 * server's does.
 *
 * Moving the API's DTOs into `packages/shared` would make them one definition, and
 * it is a real option — but it is an `apps/api` change, so it is recorded as a
 * future refactor rather than smuggled into a frontend slice.
 */

export const loginSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  tenantName: z.string().min(1, 'Name your organisation.').max(200),
  email: z.string().email('Enter a valid email address.'),
  // Mirrors the API's minimum; the server re-checks it.
  password: z.string().min(12, 'Use at least 12 characters.').max(200),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const setPasswordSchema = z.object({
  password: z.string().min(12, 'Use at least 12 characters.').max(200),
});
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;

/**
 * The invite form (`POST /users`).
 *
 * `roleSchema` IS IMPORTED FROM SHARED, AND THAT IS NOT A CONTRADICTION OF THE
 * NOTE ABOVE. The rule that note states is that REQUEST BODIES stay local
 * because they are the client's UX rules and the server is the sole authority.
 * A role enum is not a request body — it is a closed set of values both sides
 * must agree on, exactly like the error envelope beside it in `shared`. If the
 * API ever adds a fourth role, one definition should change, not two; if this
 * file hardcoded the three, a stale copy would render a `<select>` missing an
 * option the server accepts, and nothing would catch it.
 *
 * The SHAPE of the body still lives here, and still mirrors `InviteMemberDto`
 * rather than importing it: `@IsEmail()` + `@MaxLength(320)` server-side, so a
 * mismatch is a usability bug rather than a security one.
 */
export const inviteSchema = z.object({
  email: z.string().email('Enter a valid email address.').max(320, 'That address is too long.'),
  role: roleSchema,
});
export type InviteInput = z.infer<typeof inviteSchema>;
