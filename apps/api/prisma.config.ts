import path from 'node:path';

import { defineConfig } from 'prisma/config';

/**
 * The Prisma CLI resolves `.env` relative to the schema, not the repo root, so
 * without this it never sees MIGRATION_DATABASE_URL and fails validation before
 * it reaches the database. The root .env is the single source of truth — it also
 * feeds docker-compose and the web app — so it is loaded explicitly here.
 *
 * `process.loadEnvFile` is built into Node 22; no dotenv dependency needed.
 * Values already in the environment win, which is what lets CI set them directly
 * without a file present.
 */
try {
  process.loadEnvFile(path.join(__dirname, '..', '..', '.env'));
} catch {
  // No root .env — expected in CI, where the variables are set directly.
}

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
});
