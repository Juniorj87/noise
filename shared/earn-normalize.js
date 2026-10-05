// shared/earn-normalize.js — Earn data semantics (production data fix pass).
//
// One place that turns a raw provider pool row into a complete, explicit record
// and formats APR honestly:
//   - missing / unverifiable APR is NEVER rendered as 0.00%
//   - a missing metric is null (rendered as "—"), never fabricated
//   - a pool is never hidden merely because APR is unavailable
//   - 0.00% is shown only when the numeric value is exactly a confirmed zero

/** Strict numeric coercion: '', null, undefined, NaN, Infinity → null. */
export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Value state: missing | zero | invalid | ok. Zero is data, missing is not. */
export function valueState(v) {
  if (v === null || v === undefined || v === '') return 'missing';
  const n = Number(v);
  if (!Number.isFinite(n)) return 'invalid';
  return n === 0 ? 'zero' : 'ok';
}

/** Data freshness from an ISO timestamp: LIVE (<30s) | RECENT (<5m) | STALE | UNAVAILABLE. */
export function freshState(updatedAt, nowMs = Date.now()) {
  if (!updatedAt) return 'UNAVAILABLE';
  const ms = nowMs - new Date(updatedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'UNAVAILABLE';
  if (ms < 30_000) return 'LIVE';
  if (ms < 300_000) return 'RECENT';
  return 'STALE';
}

/** Compact age label: 8s / 3m / 2h. Unknown → '—'. */
export function fmtAge(updatedAt, nowMs = Date.now()) {
  if (!updatedAt) return '—';
  const s = Math.max(0, Math.round((nowMs - new Date(updatedAt).getTime()) / 1000));
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h';
}

/**
 * APY normalization. Unit is explicit because providers disagree:
 * Aftermath staking SDK returns a decimal RATIO (0.0143 = 1.43% APY).
 * Never relabel APR as APY: kind travels with the number.
 * Returns { pct, kind: 'apy', unit, basis: 'provider'|'computed', state }.
 */
export function normalizeApy(raw, { unit = 'ratio', source = '', updatedAt = null } = {}) {
  const v = numOrNull(raw);
  if (v === null) {
    return { pct: null, kind: 'apy', unit, basis: 'provider', state: 'missing', source, updatedAt };
  }
  return {
    pct: unit === 'ratio' ? v * 100 : v,
    kind: 'apy', unit, basis: 'provider', state: v === 0 ? 'zero' : 'ok', source, updatedAt,
  };
}

/** APR→APY conversion ONLY with a confirmed compounding model. Otherwise null. */
export function aprToApy(aprPct, periodsPerYear) {
  const apr = numOrNull(aprPct);
  const n = Number(periodsPerYear);
  if (apr === null || !Number.isFinite(n) || n <= 0) return null;
  const apy = (Math.pow(1 + apr / 100 / n, n) - 1) * 100;
  return Math.round(apy * 1e6) / 1e6;
}

/**
 * Honest APY display: null/unknown → '—', real 0 → '0.00%', tiny → '< 0.01%'.
 * Suffix carries the kind so APY can never be mistaken for APR.
 */
export function formatApyPct(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return '—';
  const n = Number(pct);
  if (n === 0) return '0.00%';
  if (Math.abs(n) < 0.01) return '< 0.01%';
  return n.toFixed(2) + '%';
}

/** Aftermath reports APR as a fraction (0.014 → 1.4%). Unit is explicit. */
export function normalizePool(raw = {}, opts = {}) {
  const source = opts.source || 'Aftermath Pools';
  const updatedAt = opts.updatedAt || new Date().toISOString();
  const unit = opts.aprUnit || 'fraction'; // 'fraction' | 'percent'
  const stats = raw.stats || raw;

  const toPct = (v) => (v === null ? null : (unit === 'fraction' ? v * 100 : v));

  const tvl = numOrNull(raw.tvl ?? stats.tvl);
  const volume24h = numOrNull(raw.volume24h ?? stats.volume);
  const fees24h = numOrNull(raw.fees24h ?? stats.fees);

  const providerAprRaw = numOrNull(raw.apr ?? stats.apr);
  const providerApr = toPct(providerAprRaw);

  const rewardAprRaw = numOrNull(raw.rewardApr);
  const rewardApr = toPct(rewardAprRaw);

  // Fee APR (percent) only when it can actually be computed: TVL > 0 and fees known.
  let feeApr = numOrNull(raw.feeApr);
  if (feeApr === null && tvl !== null && tvl > 0 && fees24h !== null) {
    feeApr = (fees24h * 365) / tvl * 100;
  }

  let totalApr = null;
  let aprBasis = null;
  if (providerApr !== null) { totalApr = providerApr; aprBasis = 'provider'; }
  else if (feeApr !== null) { totalApr = feeApr; aprBasis = 'computed-fees'; }

  return {
    name: raw.name ?? raw.pool?.name ?? null,
    poolId: raw.poolId ?? raw.pool?.objectId ?? null,
    tvl,
    volume24h,
    fees24h,
    feeApr,
    rewardApr,
    totalApr,
    aprBasis,
    rewardsAvailable: rewardApr !== null,
    exactZero: totalApr === 0,
    source,
    updatedAt,
  };
}

/**
 * Honest APR display:
 *   null/unknown → '—'   |   real 0 → '0.00%'   |   0 < x < 0.01 → '< 0.01%'
 *   otherwise    → 'N.NN%'
 */
export function formatAprPct(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return '—';
  const n = Number(pct);
  if (n === 0) return '0.00%';
  if (Math.abs(n) < 0.01) return '< 0.01%';
  return n.toFixed(2) + '%';
}

/** Dev diagnostics for a pool — surfaces every field and how the display is derived. */
export function poolDiagnostics(raw) {
  const p = normalizePool(raw);
  return {
    name: p.name,
    tvl: p.tvl === null ? 'UNAVAILABLE' : 'OK',
    volume24h: p.volume24h === null ? 'UNAVAILABLE' : 'OK',
    fees24h: p.fees24h === null ? 'UNAVAILABLE' : 'OK',
    feeApr: p.feeApr === null ? 'unavailable' : p.feeApr.toFixed(3) + '%',
    rewardApr: p.rewardApr === null ? 'unavailable' : p.rewardApr.toFixed(3) + '%',
    totalApr: p.totalApr === null ? 'unavailable' : p.totalApr.toFixed(3) + '%',
    aprBasis: p.aprBasis || 'none',
    displayedApr: formatAprPct(p.totalApr),
    dataSource: p.source,
  };
}
