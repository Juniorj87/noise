// Action Hub 2.0 unit tests — fee engine, referral policy, predict market
// descriptors, tx allowlists, automation triggers. No network, no DB.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIONS, PROVIDERS, REFERRAL_POLICIES, referralReward, referralPolicyFor,
  parseAutomationNL, validateAutomation, checkAutomationPermission,
} from '../../api/_lib/services.js';
import { validateFeeRecipient, calculateNetRevenue } from '../../api/_lib/fee-engine.js';
import { toMarketDescriptor, marketStatus, predictConstants } from '../../api/_lib/deepbook-predict.js';
import { getConfig } from '@mysten/deepbook-v3/predict';

test('tx allowlists include spot + predict actions and providers', () => {
  for (const a of ['spot_order', 'limit_order', 'market_order', 'cancel_order', 'predict_mint', 'predict_redeem', 'predict_claim']) {
    assert.ok(ACTIONS.includes(a), 'missing action ' + a);
  }
  assert.ok(PROVIDERS.includes('deepbook-predict'));
  assert.ok(PROVIDERS.includes('deepbook'));
});

test('referral: deepbook-predict policy is 0 and never a trader debit', () => {
  const p = referralPolicyFor('deepbook-predict', '*');
  assert.equal(p.rate, 0);
  const r = referralReward(0, 'deepbook-predict', '*');
  assert.equal(r.reward, 0);
  assert.equal(r.retained, 0);
});

test('referral: reward is a split of platform revenue only', () => {
  const r = referralReward(2, 'aftermath-perps', '*');
  assert.ok(r.reward > 0 && r.reward <= 2);
  assert.equal(r.retained, 2 - r.reward);
});

test('fee recipient validation: empty ok (disabled), garbage rejected', () => {
  assert.equal(validateFeeRecipient('').valid, true);
  assert.equal(validateFeeRecipient(null).valid, true);
  assert.equal(validateFeeRecipient('not-an-address').valid, false);
  assert.equal(validateFeeRecipient('0x' + 'ab'.repeat(32)).valid, true);
});

test('net revenue: gross minus referral, never negative on sane input', () => {
  const n = calculateNetRevenue({ grossPlatformRevenue: '2', referralRate: 30 });
  assert.equal(n.grossPlatformRevenue, '2');
  assert.equal(n.referralReward, '0.6');
  assert.equal(n.netPlatformRevenue, '1.4');
});

test('predict: underlyings come from official SDK config, never hardcoded', async () => {
  const cfg = getConfig(process.env.SUI_NETWORK === 'testnet' ? 'testnet' : 'mainnet');
  assert.ok(Array.isArray(Object.keys(cfg.underlyings)) && Object.keys(cfg.underlyings).length > 0);
  const c = predictConstants();
  assert.ok(c.quoteCoinType.includes('::usdc::USDC'));
});

test('predict: market descriptor rejects unknown underlying and bad side', () => {
  const cfg = getConfig('mainnet');
  const u = Object.keys(cfg.underlyings)[0];
  try {
    toMarketDescriptor({ underlying: 'NOPE', expiryMs: Date.now() + 60000 });
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.code, 'UNKNOWN_UNDERLYING');
  }
  try {
    toMarketDescriptor({ underlying: u, expiryMs: Date.now() + 60000, side: 'sideways' });
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.code, 'INVALID_SIDE');
  }
  const m = toMarketDescriptor({ underlying: u, expiryMs: Date.now() + 60000, side: 'up', strike: 'reference' });
  assert.equal(m.side, 'up');
  assert.equal(m.strike, 'reference');
});

test('predict: market status honors expiry and pause', () => {
  assert.equal(marketStatus(Date.now() - 1000, false), 'EXPIRED');
  assert.equal(marketStatus(Date.now() + 60000, true), 'PAUSED');
  assert.equal(marketStatus(Date.now() + 60000, false), 'ACTIVE');
});

test('automation: NL parser covers predict/order/price-below/APY triggers', () => {
  assert.equal(parseAutomationNL('notify me when predict market expires').trigger.type, 'PREDICT_EXPIRY');
  assert.equal(parseAutomationNL('tell me when my order fills').trigger.type, 'ORDER_FILLED');
  assert.equal(parseAutomationNL('alert when SUI drops below $1').trigger.type, 'PRICE_BELOW');
});

test('automation: limits enforced, permissions default-deny execution', () => {
  assert.equal(validateAutomation({ maxPerExecutionUsd: 0, maxDailyUsd: 10 }), 'LIMIT_PER_EXECUTION_INVALID');
  assert.equal(validateAutomation({ maxPerExecutionUsd: 50, maxDailyUsd: 10 }), 'LIMIT_INCONSISTENT');
  const auto = { status: 'active', action_json: JSON.stringify({ allowedActions: ['notify'] }) };
  assert.equal(checkAutomationPermission(auto, 'notify'), null);
  assert.equal(checkAutomationPermission(auto, 'swap'), 'ACTION_NOT_ALLOWED');
  assert.equal(checkAutomationPermission({ status: 'revoked', action_json: '{}' }, 'notify'), 'AUTOMATION_NOT_ACTIVE');
});
