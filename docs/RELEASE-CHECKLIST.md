# Release checklist

Check off with evidence (command output, screenshot, or probe result). Do not
check boxes on assumption. Status when written: 2026-10-10 — unchecked items
are owner-side work.

## Responsive (no device lab here — verify on hardware)

- [ ] 390 px: sidebar collapses, no horizontal scroll on Start / Place funds / Positions.
- [ ] 768 px: grids reflow (2-col), wallet picker modal fits viewport.
- [ ] 1024 px: sidebar + main column layout intact, tables readable.
- [ ] 1440 px: max-width containers centered, no stretched whitespace gaps.
- [ ] Touch device: tap highlights do not stick (`@media(hover:none)` guard present in code, needs a real tap test).

## Wallet connection (browsers × wallets)

- [ ] Chrome + Slush: connect, sign, reject paths.
- [ ] Chrome + Phantom (Sui enabled): appears in picker by name.
- [ ] Chrome/Edge + OKX (Sui network): appears in picker by name.
- [ ] Firefox + any Sui wallet: connect works or fails with a clear message.
- [ ] Decline in wallet → operation marked `rejected`, tracker stops.

## Production API (`https://noisesui.vercel.app`)

- [ ] `GET /api/health` → checkpoint + network.
- [ ] `GET /api/journey/markets?provider=` × 8 → markets with sources.
- [ ] `POST /api/journey/build` (dust, unfunded) → bytes + simulation or honest fund error.
- [ ] Malformed POST → `400 INVALID_JSON`; 300 KB POST → `413 PAYLOAD_TOO_LARGE`.
- [ ] `GET /api/referral/leaderboard`, `/api/automation?wallet=` → 200.

## Earn freshness

- [ ] haSUI/vSUI APY cards show values + basis; sSUI/mSUI show honest “unavailable”.
- [ ] Stale provider → “unavailable”, never 0% or NaN (see `formatAprPct` + panel guards).

## Integrations

- [ ] Matrix in `docs/INTEGRATIONS.md` re-verified against code after any provider change.

## License — OWNER ACTION REQUIRED

- [ ] No license file exists; default is all-rights-reserved. Choose MIT/Apache-2.0/proprietary and add `LICENSE` before public distribution claims.

## DNS — OWNER ACTION REQUIRED

- [ ] `CNAME app → cname.vercel-dns.com` at the `noisehub.xyz` registrar, then `vercel domains verify app.noisehub.xyz`. Until then the hub subdomain does not resolve.
