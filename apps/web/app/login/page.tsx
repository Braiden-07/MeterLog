'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ApiError } from '../../lib/api';
import { loginSchema, type LoginInput } from '../../lib/forms';
import { useWorkspaceState } from '../../lib/session-context';

/**
 * `useSearchParams()` forces client-side rendering for whatever reads it, so the
 * page wraps it in a Suspense boundary — without one, `next build` refuses to
 * prerender this route at all.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginForm notice={null} />}>
      <LoginWithNotice />
    </Suspense>
  );
}

function LoginWithNotice() {
  const params = useSearchParams();
  const notice =
    params.get('registered') === '1'
      ? 'Organisation created. Now sign in.'
      : params.get('password') === 'set'
        ? 'Password set. Now sign in.'
        : null;
  return <LoginForm notice={notice} />;
}

function LoginForm({ notice }: { notice: string | null }) {
  const { session } = useWorkspaceState();
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: LoginInput): Promise<void> {
    setFailure(null);
    try {
      // A successful login performs the full reset and seeds identity, so the
      // bootstrap on `/` reads the new session rather than a stale cache.
      await session.login(values);
      router.replace('/');
    } catch (error) {
      setFailure(
        error instanceof ApiError
          ? error.message
          : 'Sign-in failed. Check your details and try again.',
      );
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      {notice && <p className="text-sm text-emerald-700">{notice}</p>}

      <form className="flex flex-col gap-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
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
            autoComplete="current-password"
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
          Sign in
        </button>
      </form>

      <a className="text-sm text-slate-500 underline" href="/register">
        Create an organisation
      </a>
    </main>
  );
}
