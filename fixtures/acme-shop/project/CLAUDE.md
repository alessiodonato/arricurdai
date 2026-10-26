# Acme Shop

- Run the tests with `pnpm test`.
- Prices and tax rules live in `src/pricing.ts`; never hardcode a tax rate.
- Database access goes through `src/db/orders.ts`.
- Deploy with `scripts/deploy.sh --prod` from the main branch only.
- The legacy `oldCheckout()` helper is deprecated; do not call it.
- Keep commit messages short and in the imperative mood.

See @docs/conventions.md for code style.
