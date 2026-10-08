export function rankRoutes(quotes, { outputCostRaw = '0' } = {}) {
  const cost = BigInt(outputCostRaw);
  const live = (quotes || []).filter(q => q && !q.error && /^\d+$/.test(String(q.amountOut)) && BigInt(q.amountOut) > 0n);
  const ranked = live.map(q => ({ ...q, effectiveOutput: String(BigInt(q.amountOut) - cost) }));
  ranked.sort((a,b) => BigInt(a.effectiveOutput) === BigInt(b.effectiveOutput) ? 0 : BigInt(a.effectiveOutput) > BigInt(b.effectiveOutput) ? -1 : 1);
  return { compared: live.length, best: ranked[0]?.provider ?? null, routes: ranked, at: new Date().toISOString(), rankingBasis: 'quoted output token base units; provider route fees already included; input-token hub fee and SUI gas not subtracted without conversion' };
}
