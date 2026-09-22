import { it } from 'vitest';

// a comment line 3
it('a revoked person can be re-invited to the same tenant', async () => {
  await revoke(tx, mTechA);

  const result = await invite(tx);
  expect(result.user_created).toBe(false);
});