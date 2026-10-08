import { Transaction } from '@mysten/sui/transactions';
import { NETWORK } from './sui-provider.js';
import { positiveU64 } from '../../shared/execution-math.js';
import { isWalletAddress, jsonClient, toBytes64, naviCoinInput, turbosSdk, turbosQuote } from './lending.js';

// Official NAVI Wallet Client + Volo contract docs; on-chain dry-run verified.
export const VOLO = Object.freeze({
  package: '0x68d22cf8bdbcd11ecba1e094922873e4080d4d11133e2443fddda0bfd11dae20',
  pool: '0x2d914e23d82fedef1b5f56a32d5c64bdcc3087ccfea2b4d6ea51a71f587840e5',
  metadata: '0x680cd26af32b2bde8d3361e804c53ec1d1cfe24c7f039eb7f549e8dfde389a60',
  coinType: '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT',
});
function validate(wallet, amountMist) {
  if (NETWORK !== 'mainnet') throw Object.assign(new Error('Mainnet-only adapter'),{code:'MARKET_UNAVAILABLE'});
  if (!isWalletAddress(wallet)) throw Object.assign(new Error('Invalid wallet'),{code:'INVALID_WALLET'});
  return positiveU64(amountMist);
}
export async function voloState() {
  const c=jsonClient();
  const [pool,metadata] = await Promise.all([c.getObject({id:VOLO.pool,options:{showContent:true,showType:true}}),c.getObject({id:VOLO.metadata,options:{showContent:true,showType:true}})]);
  if (!pool.data?.content?.fields || !metadata.data?.content?.fields || !pool.data.type?.endsWith('::stake_pool::StakePool') || !metadata.data.type?.includes('::cert::Metadata<')) throw Object.assign(new Error('Volo shared objects not verified'),{code:'PROVIDER_UNAVAILABLE'});
  const fees=pool.data.content.fields.fee_config?.fields;
  if (!fees) throw Object.assign(new Error('Volo fee configuration unavailable'),{code:'PROVIDER_UNAVAILABLE'});
  return {feeBps:{stake:String(fees.stake_fee_bps),unstake:String(fees.unstake_fee_bps),rewards:String(fees.reward_fee_bps)},source:'Volo shared objects (on-chain)',updatedAt:new Date().toISOString()};
}
export function voloMove(tx, action, coin) {
  return tx.moveCall({target:`${VOLO.package}::stake_pool::${action}`,arguments:[tx.object(VOLO.pool),tx.object(VOLO.metadata),tx.object('0x5'),coin]});
}
export async function voloBuild({wallet,amountMist,action='stake'}) {
  const amount=validate(wallet,amountMist);
  if (!['stake','unstake'].includes(action)) throw Object.assign(new Error('Invalid Volo action'),{code:'INVALID_ACTION'});
  if(action==='stake' && amount<100000000n)throw Object.assign(new Error('Volo minimum stake is 0.1 SUI'),{code:'INVALID_AMOUNT'});
  const state=await voloState();
  const tx=new Transaction();
  const coin=await naviCoinInput(tx,wallet,action==='stake'?'0x2::sui::SUI':VOLO.coinType,amount);
  voloMove(tx,action+'_entry',coin);
  return {txBytes:await toBytes64(tx,wallet,action==='stake'?amount:0n),meta:{provider:'volo',action,inputAsset:action==='stake'?'SUI':'vSUI',amountMist:String(amount),protocolFees:state.feeBps,feeCollected:null}};
}
export async function turbosSwapBuild({wallet,fromType,toType,amountMist,slippage=0.01}) {
  validate(wallet,amountMist);
  const {cetusAdapter,coinType}=await import('./adapters.js');
  const symbols=['SUI','USDC','DEEP','CETUS','NAVX'];
  const from=symbols.find(s=>coinType(s)===fromType),to=symbols.find(s=>coinType(s)===toType);
  if(!from||!to)throw Object.assign(new Error('Unsupported swap asset'),{code:'UNSUPPORTED_ASSET'});
  const r=await cetusAdapter.buildSwap({from,to,amountMist,sender:wallet,slippage,venue:'turbos'});
  return {txBytes:r.txBytes,meta:{amountOut:String(r.router.amountOut),routeProviders:r.router.paths.map(p=>p.provider),feeCollected:r.feeCollected}};
}
export async function turbosFeeQuote({fromType,toType,amountMist}) {
  const {cetusAdapter,coinType}=await import('./adapters.js');
  const symbols=['SUI','USDC','DEEP','CETUS','NAVX'];
  const from=symbols.find(s=>coinType(s)===fromType),to=symbols.find(s=>coinType(s)===toType);
  if(!from||!to)throw Object.assign(new Error('Unsupported swap asset'),{code:'UNSUPPORTED_ASSET'});
  return cetusAdapter.getQuote({from,to,amountMist,venue:'turbos'});
}
