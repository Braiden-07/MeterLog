import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'MeterLog',
  description: 'Multi-tenant asset & utility-meter traceability',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}
