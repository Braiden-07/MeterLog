import { describe, expect, it } from 'vitest';

import { HealthController } from './health.controller';

// The trivial passing test the CI pipeline is proven against at scaffold
// (PROJECT_BRIEF §11 step 3).
describe('HealthController', () => {
  it('reports ok', () => {
    expect(new HealthController().check().status).toBe('ok');
  });
});
