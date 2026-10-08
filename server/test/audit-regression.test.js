import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Transaction } from '@mysten/sui/transactions';
import { positiveU64, safeSdkAmount, decimalToRaw, COIN_DECIMALS, rateFromSupplies, suilendRewardDescriptors } from '../../shared/execution-math.js';
import { rankRoutes } from '../../shared/route-ranking.js';
import { coinType } from '../../api/_lib/adapters.js';
import { SuiDataProvider } from '../../api/_lib/sui-provider.js';
import { devInspectB64 } from '../../api/_lib/lending.js';
import { SUI_SYSTEM_STATE, earnFeePreview } from '../../api/_lib/earn.js';
const root = new URL('../../',import.meta.url);
const file = n => readFileSync(new URL(n,root),'utf8');
test('raw u64 remains exact at maximum',()=>assert.equal(positiveU64('18446744073709551615'),18446744073709551615n));
test('invalid, unsafe and overflow amounts rejected',()=>{for(const n of [null,undefined,true,0,-1,1.2,'1.2','1e9','18446744073709551616',9007199254740992])assert.throws(()=>positiveU64(n),{code:'INVALID_AMOUNT'})});
test('number-only SDK amount fails rather than rounds',()=>assert.throws(()=>safeSdkAmount('9007199254740993'),{code:'INVALID_AMOUNT'}));
test('decimal conversion exact above JS safe integer',()=>assert.equal(decimalToRaw('9007199.254740993',9),'9007199254740993'));
test('excess asset precision rejected, not truncated',()=>assert.throws(()=>decimalToRaw('1.0000001',6),{code:'INVALID_AMOUNT'}));
test('CETUS and NAVX have nine decimals, DEEP six',()=>assert.deepEqual([COIN_DECIMALS.CETUS,COIN_DECIMALS.NAVX,COIN_DECIMALS.DEEP],[9,9,6]));
test('DEEP correct official package',()=>assert.equal(coinType('DEEP'),'0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP'));
test('NAVX correct official package',()=>assert.equal(coinType('NAVX'),'0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX'));
test('testnet cannot fallback to mainnet token',()=>assert.throws(()=>coinType('DEEP','testnet'),{code:'UNSUPPORTED_ASSET'}));
test('Spring rate is SUI per sSUI, not reciprocal',()=>assert.equal(rateFromSupplies('110000','100000'),1.1));
test('unknown/zero LST supply never creates invented rate',()=>{assert.equal(rateFromSupplies(null,100),null);assert.equal(rateFromSupplies(100,0),null)});
test('route rank exact above JS number precision',()=>assert.equal(rankRoutes([{provider:'A',amountOut:'9007199254740992'},{provider:'B',amountOut:'9007199254740993'}]).best,'B'));
test('input coin fee and SUI gas never subtracted from output-token raw units',()=>assert.equal(rankRoutes([{provider:'A',amountOut:'100'}],{platformFee:2,gasEst:3}).routes[0].effectiveOutput,'100'));
test('Suilend claims resolve reward descriptor array not obligation string',()=>{
 const rs=[{arrayIndex:2n,depositsPoolRewardManager:{id:'m',poolRewards:[{coinType:{name:'0x2::sui::SUI'},startTimeMs:0n} ]}}];
 const ob={userRewardManagers:[{poolRewardManagerId:'m',share:1n,rewards:[{earnedRewards:{value:1n}}]}]};
 assert.deepEqual(suilendRewardDescriptors(rs,ob),[{reserveArrayIndex:2n,rewardIndex:0n,rewardCoinType:'0x2::sui::SUI',side:'deposit'}]);
 assert.deepEqual(suilendRewardDescriptors(rs,{userRewardManagers:[]}),[]);
});
test('native stake uses system package 0x3 and object 0x5',()=>{assert.equal(BigInt(SUI_SYSTEM_STATE),5n);assert.match(file('api/_lib/earn.js'),/0x3::sui_system::request_add_stake/);assert.doesNotMatch(file('api/_lib/earn.js'),/0x2::sui_system::request_/)});
test('unknown gas fee stays unknown instead of hardcoded .01',()=>assert.equal(earnFeePreview({amountSui:10}).networkFee,null));
test('Bucket user queries pass object-shaped SDK arguments',()=>assert.match(file('api/_lib/lending.js'),/getUserPositions\(\{ address: wallet \}\)/));
test('frontend does not allow signing when simulation unavailable',()=>{const s=file('app.html');assert.doesNotMatch(s,/if \(b\.simulationStatus === 'failed'/);assert.match(s,/b\.simulationStatus !== 'success'/)});
test('simulate exact full bytes and fail closed',async()=>{
 const sender='0x'+'1'.repeat(64);const tx=new Transaction();tx.setSender(sender);tx.setGasPrice(1000);tx.setGasBudget(10000000);tx.setGasPayment([{objectId:'0x'+'2'.repeat(64),version:'1',digest:'11111111111111111111111111111111'}]);
 tx.transferObjects([tx.gas],sender);const bytes=Buffer.from(await tx.build()).toString('base64');
 const saved=SuiDataProvider.simulateTransaction;
 try{
  SuiDataProvider.simulateTransaction=async (actual,w)=>{assert.equal(actual,bytes);assert.equal(w,sender);return {value:{effects:{status:{status:'success'}}}}};
  assert.equal((await devInspectB64(bytes,sender)).ok,true);
  await assert.rejects(()=>devInspectB64(bytes,'0x'+'3'.repeat(64)),{code:'INVALID_WALLET'});
  SuiDataProvider.simulateTransaction=async()=>({value:{effects:{status:{status:'failure'}}}});
  assert.equal((await devInspectB64(bytes,sender)).ok,false);
 }finally{SuiDataProvider.simulateTransaction=saved}
});
import vm from 'node:vm';
function mockWalletApp({ network='mainnet', transactionSender='0x'+'1'.repeat(64), simulationOk=true }={}) {
 const account={address:'0x'+'1'.repeat(64),chains:['sui:mainnet']};const calls=[];
 const w={name:'Test wallet',accounts:[account],features:{'standard:connect':{connect:async()=>{}},'sui:signAndExecuteTransaction':{signAndExecuteTransaction:async input=>{calls.push(input);return{digest:'test-digest'}}},'sui:signPersonalMessage':{signPersonalMessage:async input=>{calls.push(input);return{signature:'signed',bytes:'message-bytes'}}}}};
 const window={__getWallets:()=>({get:()=>[w]}),__Transaction:{from:()=>({getData:()=>({sender:transactionSender}),toJSON:async()=>'{"version":2}',serialize:()=>'{"version":1}'})}};
 const source=file('app.html').match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace("import { getWallets } from '@wallet-standard/app';",'const getWallets = window.__getWallets;')
  .replace("const { Transaction } = await import('https://esm.sh/@mysten/sui@2.33.2/transactions');",'const Transaction = window.__Transaction;');
 vm.runInNewContext(source,{window,location:{origin:'https://noise.test'},fetch:async(url)=>({ok:true,json:async()=>String(url).endsWith('/api/sui')?{simulation:{effects:{status:{status:simulationOk?'success':'failure'}}}}:{network}}),AbortSignal,atob,TextEncoder,Uint8Array,console});
 return {app:window.HubWallet,calls,account};
}
test('Wallet Standard v2 receives transaction with toJSON, account and chain',async()=>{
 const{app,calls,account}=mockWalletApp();await app.connect();assert.equal(await app.signAndExecute('AA==',{chain:'sui:mainnet'}),'test-digest');assert.equal(calls[0].account,account);assert.equal(calls[0].chain,'sui:mainnet');assert.equal(typeof calls[0].transaction.toJSON,'function');assert.equal(calls[0].transactionBlock,undefined);
});
test('wallet refuses cross-network signing before prompt',async()=>{const{app,calls}=mockWalletApp({network:'testnet'});await app.connect();await assert.rejects(()=>app.signAndExecute('AA==',{chain:'sui:mainnet'}),{code:'NETWORK_MISMATCH'});assert.equal(calls.length,0)});
test('wallet refuses stale sender after account change',async()=>{const{app,calls}=mockWalletApp({transactionSender:'0x'+'2'.repeat(64)});await app.connect();await assert.rejects(()=>app.signAndExecute('AA==',{chain:'sui:mainnet'}),{code:'ACCOUNT_CHANGED'});assert.equal(calls.length,0)});
test('personal-message signing supplies account and returns signature not message bytes',async()=>{const{app,calls,account}=mockWalletApp();await app.connect();assert.equal(await app.signPersonalMessage('challenge'),'signed');assert.equal(calls[0].account,account)});
import { boundedGasPayment } from '../../api/_lib/gas-payment.js';
test('gas payment bounded below chain limit for fragmented wallets',async()=>{const tx=new Transaction();const coins=Array.from({length:300},(_,i)=>({coinObjectId:'0x'+(i+1).toString(16).padStart(64,'0'),version:'1',digest:'11111111111111111111111111111111',balance:String(i+1)}));await boundedGasPayment(tx,'0x'+'1'.repeat(64),{getCoins:async()=>({data:coins,hasNextPage:false})});assert.ok(tx.getData().gasData.payment.length <= 128)});
test('address-balance wallets without Coin objects retain SDK gas resolution',async()=>{const tx=new Transaction();await boundedGasPayment(tx,'0x'+'1'.repeat(64),{getCoins:async()=>({data:[],hasNextPage:false})});assert.equal(tx.getData().gasData.payment,null)});
import { normalizeChainIdentifier } from '../../api/_lib/sui-provider.js';
test('gRPC genesis digest normalizes to JSON-RPC chain identifier',()=>assert.equal(normalizeChainIdentifier('4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S'),'35834a8a'));
test('invalid chain identity cannot masquerade as a network',()=>assert.equal(normalizeChainIdentifier('mainnet'),null));
import {venueConfig,assertVenueRouter} from '../../shared/routed-venues.js';
import {voloBuild} from '../../api/_lib/protocol-execution.js';
import {liquidityBuild} from '../../api/_lib/liquidity.js';
import {naviCoinInput} from '../../api/_lib/lending.js';
test('explicit DEX venue requires only its verified providers',()=>{assert.deepEqual(venueConfig('flowx').providers,['FLOWX','FLOWXV3']);assert.throws(()=>venueConfig('not-a-venue'),{code:'INVALID_PROVIDER'})});
test('SDK empty/error route is rejected before swap build',()=>{for(const r of [{paths:[],amountOut:'0',insufficientLiquidity:false},{paths:[{provider:'FLOWX'}],amountOut:'5',error:{msg:'bad provider'}}])assert.throws(()=>assertVenueRouter(r,venueConfig('flowx')),{code:'INSUFFICIENT_LIQUIDITY'})});
test('router cannot silently substitute another DEX',()=>{assert.throws(()=>assertVenueRouter({paths:[{provider:'MOMENTUM'}],amountOut:'100'},venueConfig('flowx')),{code:'INVALID_PROVIDER'});assert.doesNotThrow(()=>assertVenueRouter({paths:[{provider:'FLOWXV3'}],amountOut:'100'},venueConfig('flowx')))});
test('Volo invalid wallet rejected without on-chain reads',async()=>assert.rejects(()=>voloBuild({wallet:'invalid',amountMist:'1000000000'}),{code:'INVALID_WALLET'}));
test('Volo minimum stake enforced before building',async()=>assert.rejects(()=>voloBuild({wallet:'0x'+'1'.repeat(64),amountMist:'99999999'}),{code:'INVALID_AMOUNT'}));
test('LP invalid wallet and invalid slippage fail before provider requests',async()=>{await assert.rejects(()=>liquidityBuild({wallet:'bad'}),{code:'INVALID_WALLET'});await assert.rejects(()=>liquidityBuild({wallet:'0x'+'1'.repeat(64),action:'deposit',slippageBps:501}),{code:'INVALID_AMOUNT'})});
test('canonical padded SUI uses gas coin input, not duplicate owned coin',async()=>{const tx=new Transaction();await naviCoinInput(tx,'0x'+'1'.repeat(64),'0x'+'2'.padStart(64,'0')+'::sui::SUI',100n);assert.equal(tx.getData().commands[0].$kind,'SplitCoins')});
test('Discover missing legacy token table cannot throw in failure handler',async()=>{const source=file('app.html');const a=source.indexOf('async function loadDiscover()'),b=source.indexOf('function openToken',a);const fn=vm.runInNewContext('('+source.slice(a,b).trim()+')',{$:id=>id==='poolGrid'?{}:null,Date,TOKEN_SYMS:['SUI'],apiGet:async()=>{throw new Error('provider unavailable')},loadSuipump:async()=>{}});await assert.doesNotReject(()=>fn())});
test('STEAMM LP production builder encodes quoted minimum LP on-chain',()=>{const s=file('api/_lib/liquidity.js');assert.match(s,/tx\.splitCoins\(lp,\s*\[tx\.pure\.u64\(minimumLp\)\]/);assert.match(s,/SIMULATION_FAILED/);assert.match(s,/parseStructTag\(object\.data\?\.type/)});
import {normalizeSteammEvents} from '../../api/_lib/liquidity.js';
test('STEAMM GraphQL TypeName strings adapt without inventing or mutating data',()=>{const raw={data:[[{parsedJson:{event:{pool_id:'0xabc',coin_type_a:'abc::coin::COIN',lp_token_type:{name:'def::lp::LP'}}}}]]};const result=normalizeSteammEvents(raw);assert.deepEqual(result.data[0][0].parsedJson.event.coin_type_a,{name:'abc::coin::COIN'});assert.equal(raw.data[0][0].parsedJson.event.coin_type_a,'abc::coin::COIN');assert.equal(result.data[0][0].parsedJson.event.pool_id,'0xabc')});
test('swap fee preview never invents gas or sums unrelated asset units',()=>{const ui=file('app.html');assert.match(ui,/network: null, total: null/);assert.match(ui,/const plat = b\.feeCollected \? Number\(b\.feeCollected\.amountMist\)/);assert.match(file('api/_lib/handlers/swap.js'),/feeBreakdown\.networkFeeAsset = 'SUI'/);assert.match(file('api/_lib/handlers/swap.js'),/feeBreakdown\.total = null/)});

test('wallet refuses failed fresh simulation before wallet feature call',async()=>{const{app,calls}=mockWalletApp({simulationOk:false});await app.connect();await assert.rejects(()=>app.signAndExecute('AA==',{chain:'sui:mainnet'}),{code:'SIMULATION_FAILED'});assert.equal(calls.length,0)});
