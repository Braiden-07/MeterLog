import type { Metadata } from 'next';

import './globals.css';
import { SessionProvider } from '../lib/session-context';

export const metadata: Metadata = {
  title: 'MeterLog',
  description: 'Multi-tenant asset & utility-meter traceability',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">
        {/*
          One QueryClient and one WorkspaceSession for the whole app. The session
          owns the cache reset, so it must not be per-route: a second instance would
          mean a second cache that no reset reaches.
        */}
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
