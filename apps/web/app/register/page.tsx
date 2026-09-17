'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { ApiError, createApiClient } from '../../lib/api';
import { registerSchema, type RegisterInput } from '../../lib/forms';

const api = createApiClient((input, init) => fetch(input, init));

/**
 * Registration creates an organisation and its first admin.
 *
 * 201 DOES NOT LOG THE USER IN — the API keeps registration single-purpose and
 * issues no cookie (ADR-006 §5). So this routes to `/login` with a "now sign in"
 * notice rather than pretending to have a session. Faking one here would mean the
 * client's idea of being signed in could differ from the server's.
 */
export default function RegisterPage() {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { tenantName: '', email: '', password: '' },
  });

  async function onSubmit(values: RegisterInput): Promise<void> {
    setFailure(null);
    try {
      await api.request({ method: 'POST', path: '/auth/register', body: values });
      router.replace('/login?registered=1');
    } catch (error) {
      setFailure(
        error instanceof ApiError ? error.message : 'Registration failed. Try again shortly.',
      );
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold tracking-tight">Create an organisation</h1>

      <form className="flex flex-col gap-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <label className="flex flex-col gap-1 text-sm">
          Organisation name
          <input
            className="rounded border border-slate-300 px-2 py-1"
            {...form.register('tenantName')}
          />
          {form.formState.errors.tenantName && (
            <span className="text-red-600">{form.formState.errors.tenantName.message}</span>
          )}
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            autoComplete="username"
            className="rounded border border-slate-300 px-2 py-1"
            {...form.register('email')}
          />
          {form.formState.errors.email && (
            <span className="text-red-600">{form.formState.errors.email.message}</span>
          )}
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            type="password"
            autoComplete="new-password"
            className="rounded border border-slate-300 px-2 py-1"
            {...form.register('password')}
          />
          {form.formState.errors.password && (
            <span className="text-red-600">{form.formState.errors.password.message}</span>
          )}
        </label>

        {failure && <p className="text-sm text-red-600">{failure}</p>}

        <button
          type="submit"
          className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-60"
          disabled={form.formState.isSubmitting}
        >
          Create organisation
        </button>
      </form>

      <a className="text-sm text-slate-500 underline" href="/login">
        I already have an account
      </a>
    </main>
  );
}
