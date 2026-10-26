# Conventions

- Validate request bodies with `zod` at API boundaries.
- Money is stored in integer cents; see `toCents()` in `src/pricing.ts`.
