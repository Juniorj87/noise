# SECURITY — non-custodial boundaries

- The hub never receives seeds or private keys and never signs. The wallet
  signs reviewed PTBs after a passing simulation.
- Simulation gates every execution path; `simulation_failed` blocks signing.
- Fees are transparent pre-sign (protocol / provider / hub / network);
  displayed fee === actual transaction.
- Automation carries `allowedActions`, amount/daily limits, expiry, owner;
  default NL intent is notify-only; pause/resume/revoke anytime. Automation
  never auto-buys discovery tokens without explicit authorization.
- Fee recipient is env/admin only — no user/AI-controlled recipient API.
- Protocol/discovery text is untrusted input: validated, sanitized, never
  trusted for recipients; AI cannot invent balances/APY, cannot sign, cannot
  bypass simulation or limits.
- Admin: `ADMIN_KEY` server-side (`X-Admin-Key`); never persisted in
  frontend storage beyond the tab session; admin UI unlinked from the app.
- Per-provider timeouts/breakers; Postgres-only production state; Vercel
  Cron (tx tracker, automation) with `CRON_SECRET`; strict CORS allowlist.

No claims of "100% secure", "risk-free", or "guaranteed" anywhere.
Protocol, contract, liquidity and market risks always apply.
