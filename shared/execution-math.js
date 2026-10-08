// Exact amount validation shared by execution adapters and quotes.
export const U64_MAX = 18446744073709551615n;
import { MAINNET_ASSETS } from './assets.js';
export const COIN_DECIMALS = Object.freeze(Object.fromEntries(MAINNET_ASSETS.map(a=>[a.symbol,a.decimals])));
function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID_AMOUNT' }); }
export function positiveU64(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw invalid('Use a raw integer string; unsafe numbers lose precision.');
  if (!['string', 'number', 'bigint'].includes(typeof value) || !/^\d+$/.test(String(value))) throw invalid('Amount must be a raw positive integer.');
  const n = BigInt(value);
  if (n <= 0n || n > U64_MAX) throw invalid('Amount must be positive and fit u64.');
  return n;
}
export function safeSdkAmount(value) {
  const n = positiveU64(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('This SDK accepts numbers only; this amount cannot be represented exactly.');
  return Number(n);
}
export function decimalToRaw(value, decimals) {
  const s = String(value ?? '').trim().replace(',', '.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^\d+(\.\d+)?$/.test(s)) throw invalid('Invalid decimal amount.');
  const [whole, fraction = ''] = s.split('.');
  if (fraction.length > decimals) throw invalid('Amount exceeds asset decimal precision.');
  return String(positiveU64(BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')));
}
export function rateFromSupplies(suiSupply, lstSupply) {
  if (suiSupply == null || lstSupply == null) return null;
  const sui = Number(suiSupply), lst = Number(lstSupply);
  return Number.isFinite(sui) && Number.isFinite(lst) && sui >= 0 && lst > 0 ? sui / lst : null;
}
export function suilendRewardDescriptors(reserves, obligation, now = Date.now()) {
  const rewards = [];
  for (const reserve of reserves || []) {
    for (const [side, manager] of [['deposit', reserve.depositsPoolRewardManager], ['borrow', reserve.borrowsPoolRewardManager]]) {
      if (!manager) continue;
      const user = (obligation.userRewardManagers || []).find(u => u.poolRewardManagerId === manager.id);
      if (!user) continue;
      for (const [index, reward] of (manager.poolRewards || []).entries()) {
        if (reward == null) continue;
        const earned = BigInt(user.rewards?.[index]?.earnedRewards?.value ?? 0);
        const accruing = BigInt(user.share || 0) > 0n && Number(reward.startTimeMs) <= now;
        if (earned <= 0n && !accruing) continue;
        const coinType = reward.coinType?.name ?? reward.coinType;
        if (typeof coinType !== 'string') continue;
        rewards.push({ reserveArrayIndex: BigInt(reserve.arrayIndex), rewardIndex: BigInt(index), rewardCoinType: coinType, side });
      }
    }
  }
  return rewards;
}
