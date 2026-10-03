// Earn/Staking pure-logic tests — no network, no provider calls.
// Covers integer MIST parsing, fee-preview math (integer money),
// and normalization of validators/delegations.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseMistAmount, earnFeePreview, normalizeValidators, normalizeDelegations,
  MIN_STAKE_MIST, MIN_UNSTAKE_MIST, SUI_TYPE, SUI_SYSTEM_STATE,
} = await import('../../api/_lib/earn.js');

test('parseMistAmount: digit strings and safe integers', () => {
  assert.equal(parseMistAmount('1000000000'), 1_000_000_000n);
  assert.equal(parseMistAmount(2500000000), 2_500_000_000n);
  assert.equal(parseMistAmount('0'), 0n);
  // u64 max is accepted
  assert.equal(parseMistAmount('18446744073709551615'), 18446744073709551615n);
});

test('parseMistAmount: rejects floats, negatives, hex, overflow', () => {
  assert.equal(parseMistAmount('1.5'), null);
  assert.equal(parseMistAmount('-5'), null);
  assert.equal(parseMistAmount('0x10'), null);
  assert.equal(parseMistAmount(''), null);
  assert.equal(parseMistAmount(null), null);
  assert.equal(parseMistAmount(undefined), null);
  assert.equal(parseMistAmount('18446744073709551616'), null); // u64 max + 1
  assert.equal(parseMistAmount(1.5), null);
  assert.equal(parseMistAmount(-1), null);
});

test('earnFeePreview: zero platform bps → zero platform fee', () => {
  const f = earnFeePreview({ amountSui: 10, earnBps: 0 });
  assert.equal(f.platformFee, 0);
  assert.equal(f.protocolFee, 0);
  assert.equal(f.networkFee, 0.01);
  assert.equal(f.total, 0.01);
});

test('earnFeePreview: integer math for platform + protocol fees', () => {
  const f = earnFeePreview({ amountSui: 100, earnBps: 20, protocolFeeRatio: 0.05 });
  assert.equal(f.platformFee, 0.2);   // 100 * 20/10000
  assert.equal(f.protocolFee, 5);     // 100 * 0.05
  assert.equal(f.total, 5.21);
  assert.equal(f.protocolFeeBasis, undefined);
});

test('earnFeePreview: rounding is stable at 6 decimals', () => {
  const f = earnFeePreview({ amountSui: 1, earnBps: 33, protocolFeeRatio: 0.0123 });
  assert.equal(f.platformFee, 0.0033);
  assert.equal(f.protocolFee, 0.0123);
  assert.equal(f.total, 0.0256);
});

test('normalizeValidators: merges chain APYs, sorts by pool balance', () => {
  const state = {
    activeValidators: [
      { suiAddress: '0xaaa', name: 'A', commissionRate: '0.01', stakingPoolSuiBalance: '100', votingPower: '10' },
      { suiAddress: '0xbbb', name: 'B', commissionRate: '0.02', stakingPoolSuiBalance: '300', votingPower: '30' },
    ],
  };
  const apys = { apys: [{ address: '0xaaa', apy: 0.034 }], epoch: '42' };
  const out = normalizeValidators(state, apys);
  assert.equal(out.length, 2);
  assert.equal(out[0].suiAddress, '0xbbb'); // sorted desc by pool balance
  assert.equal(out[0].apy, null);           // no APY reported for bbb
  assert.equal(out[1].apy, 0.034);          // APY merged case-insensitively
  assert.equal(out[1].commissionRate, '0.01');
});

test('normalizeValidators: empty state → empty list', () => {
  assert.deepEqual(normalizeValidators(null, null), []);
  assert.deepEqual(normalizeValidators({ activeValidators: [] }, { apys: [] }), []);
});

test('normalizeDelegations: sums principal, keeps statuses and rewards', () => {
  const input = [
    {
      validatorAddress: '0xval',
      stakingPool: '0xpool',
      stakes: [
        { stakedSuiId: '0x1', principal: '1000000000', stakeRequestEpoch: 42n, stakeActiveEpoch: 43n, status: 'Active', estimatedReward: '5000000' },
        { stakedSuiId: '0x2', principal: '2000000000', stakeRequestEpoch: 43n, stakeActiveEpoch: 43n, status: 'Pending' },
      ],
    },
  ];
  const { rows, stakedMist } = normalizeDelegations(input);
  assert.equal(rows.length, 2);
  assert.equal(stakedMist, '3000000000');
  assert.equal(rows[0].principal, '1000000000');
  assert.equal(rows[0].status, 'Active');
  assert.equal(rows[0].estimatedReward, '5000000'); // rewards only for Active
  assert.equal(rows[1].status, 'Pending');
  assert.equal(rows[1].estimatedReward, '0');       // no reward estimate for Pending
  assert.equal(rows[1].stakeActiveEpoch, '43');
});

test('constants: on-chain minimums and addresses', () => {
  assert.equal(MIN_STAKE_MIST, 1_000_000_000n); // 1 SUI
  assert.equal(MIN_UNSTAKE_MIST, 1_000_000_000n);
  assert.equal(SUI_TYPE, '0x2::sui::SUI');
  assert.equal(SUI_SYSTEM_STATE, '0x0000000000000000000000000000000000000000000000000000000000000006');
});
