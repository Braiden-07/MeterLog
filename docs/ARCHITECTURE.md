# ARCHITECTURE.md — MeterLog

> Living architecture description. Keep current as modules land.
> Authoritative scope lives in `PROJECT_BRIEF.md`; choices are justified in `DECISIONS.md`.

## 1. Overview

## 2. System diagram

## 3. Repository layout

```
meterlog/
├── apps/
│   ├── api/                     NestJS — REST under /api/v1
│   │   ├── prisma/
│   │   │   ├── schema.prisma            datasource → MIGRATION_DATABASE_URL (CLI only)
│   │   │   └── migrations/              role bootstrap; RLS ships as hand-written SQL
│   │   ├── src/
│   │   │   ├── common/prisma/           runtime client, bound to DATABASE_URL
│   │   │   └── health/                  GET /api/v1/health
│   │   └── test/db/                     catalog RLS suite + definer probe
│   ├── web/                     Next.js App Router (Tailwind, TanStack Query, RHF, Zod)
│   └── ...
├── packages/shared/             Zod contracts shared by both apps
├── docker/postgres/             local-only role bootstrap (first-start init)
├── docs/                        BRIEF · PROGRESS · DECISIONS · ARCHITECTURE
├── .github/workflows/ci.yml     lint → typecheck → test → build
└── docker-compose.yml           Postgres 16 + Redis 7
```

## 4. Backend modules

### 4.1 Auth

### 4.2 Tenants

### 4.3 Users

### 4.4 Assets

### 4.5 Readings

### 4.6 Maintenance

### 4.7 Audit

### 4.8 Common (guards, interceptors, filters, DTOs)

## 5. Frontend structure

## 6. Data model

### 6.1 ERD

### 6.2 Tables

### 6.3 Indexes

## 7. Tenant isolation (Row-Level Security)

### 7.1 Policy design

### 7.2 Per-request tenant context

### 7.3 Transaction & statement timeouts

### 7.4 Database roles & privileges

### 7.5 Pre-auth access path (SECURITY DEFINER functions)

### 7.6 How isolation is tested (two-tenant + catalog coverage)

## 8. Authentication & session handling

## 9. Authorization (RBAC matrix)

## 10. Audit logging

## 11. API conventions

## 12. Error handling & logging

## 13. Configuration & secrets

## 14. Local development

## 15. CI/CD

## 16. Deployment topology

## 17. Observability

## 18. Known limitations
