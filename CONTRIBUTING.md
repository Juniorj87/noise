# Contributing to Noise Hub

## Process

1. Open an issue describing the problem (what breaks, where, with evidence) before large changes.
2. Keep pull requests small and focused: one capability or fix per PR.
3. Every PR must state what was actually verified: `npm run build`, relevant `npm run test:*` / `audit:*` output, and which claims were checked against live reads or simulations.
4. Do not bundle refactors, renames, or unrelated cleanups into a feature PR.

## Coding conventions

- Fail-closed errors with stable codes; no silent fallbacks.
- Live reads only. Unreachable provider → report unavailable, never interpolate.
- Exchange rates are not yields. Unknown rewards are not zero.
- New transaction builders require a simulation test before UI wiring.
- No secrets in code, fixtures, or screenshots. `.env.example` keeps placeholders only.
- Public docs stay in English and product-focused; server-launch detail belongs in `docs/DEVELOPMENT.md`.

## Definition of done

- `npm run build` passes (it parses all serverless modules and inline frontend scripts).
- Touched flows are covered by unit tests or recorded live checks under `audit/`.
- README/docs claims match the implementation; no invented coverage.
