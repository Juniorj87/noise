# Full transaction cycle — controlled test scenario

Status: SCENARIO ONLY. No step here moves funds without an explicit,
in-wallet user signature, and steps 6–9 require a funded test wallet plus
a separate owner go-ahead. Do not treat build/simulation success below as a
confirmed transaction.

## Prerequisites

- A wallet with a small, expendable test amount (Sui mainnet dust or, safer,
  a testnet wallet if the backend is pointed at testnet — never the primary
  holdings wallet).
- Production app open at the deployed URL; browser console visible.
- A second observer (address on a block explorer) to confirm on-chain state
  independently of hub UI.

## Steps

1. **Connect.** Connect the test wallet. Expected: address shown truncated,
   chain `sui:mainnet`, no keys requested anywhere.
2. **Balance.** Open Portfolio. Expected: balances match the explorer for the
   same address; missing prices show “unavailable”, never zero-invented.
3. **Build (unsigned).** Place funds → SUI → Suilend, dust amount → Review &
   simulate. Expected: review shows input, minimum received, fee + recipient,
   gas estimate, expiry; `txBytes` + `expectedDigest` issued, nothing signed.
4. **Simulation gate.** Tamper the amount in devtools (or pick an
   over-balance amount) and rebuild. Expected: `SIMULATION_FAILED`, signing
   blocked, no bytes offered.
5. **Signing blocked after expiry.** Let a review expire (> 60 s), then sign.
   Expected: rebuild required, stale plan rejected.
6. **User signs (OWNER GO-AHEAD REQUIRED).** Approve ONLY the reviewed
   transaction in the wallet. Expected: wallet shows its own confirmation
   screen with matching amount/recipient.
7. **Digest.** Record the returned digest. It must equal `expectedDigest` or
   the app treats the result as untrusted and never resubmits.
8. **Confirmation.** Check the digest on Suiscan + hub receipt lookup.
   Expected: `confirmed` with matching sender, effects, and balance changes.
9. **Activity.** Refresh positions/activity. Expected: new position appears,
   receipt recorded, leaderboard credited only for the prepared digest.

## Abort rules

- Any mismatch (digest, amount, recipient, chain) → stop, inspect wallet
  history, do not resubmit.
- Any on-chain failure → record as failed; gas may be charged; no silent retry.
- Rejection in wallet → operation marked `rejected`; tracker stops.
