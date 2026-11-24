# ClaimPilot — Phase 1 MVP

B2B Restaurant POS Electronic Journal (EJ) & Third-Party Delivery Chargeback Reconciliation Platform.

## Quick Start

```bash
# Run the Vitest unit & PostgreSQL integration test suite
npm test

# Start the Next.js Operations Dashboard
npm run dev
```

By default, if `DATABASE_URL` is not set in the environment, ClaimPilot automatically boots an embedded persistent PostgreSQL instance (`.data/pgdata`) and applies [migrations/001_initial_schema.sql](migrations/001_initial_schema.sql). To connect to an external PostgreSQL server, set `DATABASE_URL=postgres://user:pass@host:5432/claimpilot`.
