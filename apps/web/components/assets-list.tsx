'use client';

import { useQuery } from '@tanstack/react-query';

import { createApiClient } from '../lib/api';
import { useWorkspaceState } from '../lib/session-context';

interface Asset {
  id: string;
  serialNumber: string;
  type: string;
  status: string;
  location: string | null;
}

interface AssetPage {
  items: Asset[];
  nextCursor: string | null;
}

const api = createApiClient((input, init) => fetch(input, init));

/**
 * READ-ONLY asset list — the visible eviction target.
 *
 * Its job in this slice is to give the switch something real to evict in a
 * browser, not only in the unit test: real tenant-scoped rows under a
 * `['tenant', tenantId, …]` key. Create and edit belong to the domain slice.
 *
 * The query comes from `session.tenantQuery`, so it carries the tenant prefix, the
 * cancel-on-reset behaviour and the cache-generation guard for free. Building the
 * key by hand here is exactly the drift that guard exists to prevent.
 */
export function AssetsList() {
  const { session } = useWorkspaceState();

  const query = useQuery(
    session.tenantQuery<AssetPage>(['assets', 'list'], async ({ signal, expectedTenant }) =>
      api.request<AssetPage>({ path: '/assets?limit=25', signal, expectedTenant }),
    ),
  );

  if (query.isPending) return <p className="text-sm text-slate-500">Loading assets…</p>;
  if (query.isError) {
    return <p className="text-sm text-red-600">Assets could not be loaded. Try again shortly.</p>;
  }

  const items = query.data?.items ?? [];
  if (items.length === 0) {
    return <p className="text-sm text-slate-500">No assets in this workspace yet.</p>;
  }

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-slate-500">
          <th className="py-2">Serial</th>
          <th className="py-2">Type</th>
          <th className="py-2">Status</th>
          <th className="py-2">Location</th>
        </tr>
      </thead>
      <tbody>
        {items.map((asset) => (
          <tr key={asset.id} className="border-b border-slate-100">
            <td className="py-2 font-medium">{asset.serialNumber}</td>
            <td className="py-2">{asset.type}</td>
            <td className="py-2">{asset.status}</td>
            <td className="py-2 text-slate-500">{asset.location ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
