export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-3 px-6">
      <h1 className="text-2xl font-semibold tracking-tight">MeterLog</h1>
      <p className="text-slate-600">
        Multi-tenant asset &amp; utility-meter traceability. Scaffold only — the auth flow, asset
        views and audit trail arrive from build-order step 8.
      </p>
    </main>
  );
}
