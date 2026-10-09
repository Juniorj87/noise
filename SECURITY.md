# Security policy

## Scope

Noise Hub (`app.html`, `api/`, `shared/`) — a non-custodial Sui interface. The security model is documented in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

## Reporting a vulnerability

- Use **GitHub private vulnerability reporting** on this repository (`Security` tab → `Report a vulnerability`). It keeps details visible to maintainers only.
- If private reporting is unavailable, open a minimal public issue describing the impact area without exploit details, and mention a contact channel on your profile for follow-up.
- Do not post exploit code, private keys, or personal data in public issues.

Please include: affected file/route, what you expected, what happened, and reproduction steps that avoid mainnet funds where possible.

## What to expect

- Acknowledgement of valid reports as fast as the maintainer team can manage; this is a small open-source project with no SLA.
- There is **no bug bounty program**. No rewards are promised.

## Ground rules

- Do not test against other users' wallets or funds.
- Do not attack production infrastructure (RPC providers, indexers, hosting) — report the finding instead.
- Valid findings handle: unauthorized transaction construction, signing bypasses, fee-recipient tampering, receipt spoofing, key-material exposure, injection into persisted records.
