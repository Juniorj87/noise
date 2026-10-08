// Real LP PTBs. The server never signs, submits, or takes custody.
import {Transaction} from '@mysten/sui/transactions';
import {normalizeStructTag,parseStructTag} from '@mysten/sui/utils';
import {SteammSDK,MAINNET_CONFIG} from '@suilend/steamm-sdk';
import {aftermathAdapter} from './adapters.js';
import {NETWORK} from './sui-provider.js';
import {isWalletAddress,grpcClient,jsonClient,aftermathSdk,naviCoinInput,toBytes64,devInspectB64} from './lending.js';
import {positiveU64,decimalToRaw} from '../../shared/execution-math.js';
function fail(code,message){throw Object.assign(new Error(message),{code})}
function mainnet(){if(NETWORK!=='mainnet')fail('MARKET_UNAVAILABLE','LP adapters are mainnet-only')}
// The GraphQL MoveValue JSON codec flattens Move TypeName to a string,
// while the current STEAMM event parser requires { name: string }.
export function normalizeSteammEvents(result) {
  const event = e => {
    const body = e.parsedJson?.event;
    if (!body) return e;
    const mapped = { ...body };
    for (const key of ['coin_type_a', 'coin_type_b', 'lp_token_type', 'quoter_type']) {
      if (typeof mapped[key] === 'string') mapped[key] = { name: mapped[key].replace(/^0x/, '') };
    }
    return { ...e, parsedJson: { ...e.parsedJson, event: mapped } };
  };
  return { ...result, data: result.data.map(page => Array.isArray(page) ? page.map(event) : event(page)) };
}
function sdk() {
  const client = new SteammSDK({ ...MAINNET_CONFIG, grpcClient: grpcClient(),
    graphqlUrl: process.env.SUI_GRAPHQL_URL || 'https://graphql.mainnet.sui.io/graphql',
    ...(process.env.PYTH_PRO_ACCESS_TOKEN ? { pythPro: {accessToken: process.env.PYTH_PRO_ACCESS_TOKEN} } : {}) });
  const query = client.fullClient.queryEventsByPage.bind(client.fullClient);
  client.fullClient.queryEventsByPage = async (...args) => normalizeSteammEvents(await query(...args));
  return client;
}
let catalogPromise, catalogAt=0;
async function steammCatalog(){
  if(!catalogPromise||Date.now()-catalogAt>120000){catalogAt=Date.now();const client=sdk();catalogPromise=Promise.all([client.fetchPoolData(),client.fetchBankData()]).then(([pools,banks])=>({pools,banks,client})).catch(e=>{catalogPromise=null;throw e})}
  return catalogPromise;
}
async function meta(coinType){const result=await grpcClient().core.getCoinMetadata({coinType});const m=result.coinMetadata;if(!m||!Number.isInteger(m.decimals))fail('PROVIDER_UNAVAILABLE','Coin metadata unavailable for '+coinType);return{coinType,decimals:m.decimals,symbol:m.symbol}}
export async function liquidityPools(provider='aftermath'){
  mainnet();
  if(provider==='steamm'){const c=await steammCatalog();return{pools:c.pools.map(p=>({poolId:p.poolId,name:p.coinTypeA.split('::').pop()+' / '+p.coinTypeB.split('::').pop()+' · '+p.poolId.slice(0,10)})),source:'STEAMM on-chain registry',updatedAt:new Date().toISOString()}}
  if(provider!=='aftermath')fail('INVALID_PROVIDER','Unknown LP provider');
  const summaries=await aftermathAdapter.getPoolSummaries(50);
  return{pools:summaries.value.map(p=>({poolId:p.poolId,name:p.name})),source:'Aftermath active pool summaries',updatedAt:summaries.updatedAt};
}
export async function resolvePool(provider,poolId){
  mainnet();if(!isWalletAddress(poolId))fail('INVALID_POOL','Invalid pool id');
  if(provider==='aftermath'){const af=await aftermathSdk(),pool=await af.Pools().getPool({objectId:poolId});return{pool,assets:await Promise.all(Object.keys(pool.pool.coins).map(meta)),lp:await meta(pool.pool.lpCoinType)}}
  if(provider==='steamm'){const c=await steammCatalog();const p=c.pools.find(p=>p.poolId.toLowerCase()===poolId.toLowerCase());if(!p)fail('INVALID_POOL','Pool is not in the verified STEAMM registry');// GraphQL MoveValue TypeName JSON is a string, while this SDK expects
  // {name:string}. Resolve authoritative generic types from the pool object.
  const object=await jsonClient().getObject({id:poolId,options:{showType:true}});
  const tag=parseStructTag(object.data?.type||'');
  if(tag.module!=='pool'||tag.name!=='Pool'||tag.typeParams.length!==4||normalizeStructTag(object.data.type).split('::')[0]!==MAINNET_CONFIG.packages.steamm.packageId)fail('INVALID_POOL','Not a STEAMM pool object');
  const [coinTypeA,coinTypeB,quoterType,lpTokenType]=tag.typeParams.map(normalizeStructTag);
  const poolInfo={...p,coinTypeA,coinTypeB,quoterType,lpTokenType};
  const bankInfoA=Object.values(c.banks).find(b=>normalizeStructTag(b.btokenType)===coinTypeA),bankInfoB=Object.values(c.banks).find(b=>normalizeStructTag(b.btokenType)===coinTypeB);
  if(!bankInfoA||!bankInfoB)fail('PROVIDER_UNAVAILABLE','STEAMM banks not found');return{poolInfo,bankInfoA,bankInfoB,assets:await Promise.all([meta(bankInfoA.coinType),meta(bankInfoB.coinType)]),lp:await meta(poolInfo.lpTokenType)}}
  fail('INVALID_PROVIDER','Unknown LP provider');
}
export async function liquidityPool(provider,poolId){const p=await resolvePool(provider,poolId);return{poolId,provider,assets:p.assets,lp:p.lp,source:provider+' on-chain pool and coin metadata',updatedAt:new Date().toISOString()}}
export async function liquidityBuild(b){
  mainnet();if(!isWalletAddress(b.wallet))fail('INVALID_WALLET','Invalid wallet');
  if(!['deposit','withdraw'].includes(b.action))fail('INVALID_ACTION','Use deposit or withdraw');
  const slippageBps=Number(b.slippageBps??100);if(!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>500)fail('INVALID_AMOUNT','Slippage must be 0–500 bps');
  const p=await resolvePool(b.provider,b.poolId),slippage=slippageBps/10000;
  const assets=p.assets,amounts={};let suiSpend=0n;
  if(b.action==='deposit'){
    if(!b.amounts||typeof b.amounts!=='object')fail('INVALID_AMOUNT','Deposit amounts required');
    for(const key of Object.keys(b.amounts))if(!assets.some(a=>normalizeStructTag(a.coinType)===normalizeStructTag(key)))fail('INVALID_AMOUNT','Asset does not belong to this pool');
    for(const a of assets){const val=b.amounts[a.coinType];if(val!=null && String(val).trim()!=='' && !/^0(?:\.0+)?$/.test(String(val))){amounts[a.coinType]=positiveU64(decimalToRaw(String(val),a.decimals));if(normalizeStructTag(a.coinType)===normalizeStructTag('0x2::sui::SUI'))suiSpend=amounts[a.coinType]}}
    if(!Object.keys(amounts).length)fail('INVALID_AMOUNT','Positive deposit required');
  }
  let tx,expectedLp=null,minimumLp=null;
  const lpAmount=b.action==='withdraw'?positiveU64(decimalToRaw(String(b.lpAmount),p.lp.decimals)):null;
  if(b.provider==='aftermath'){
    if(b.action==='deposit'){expectedLp=p.pool.getDepositLpAmountOut({amountsIn:amounts}).lpAmountOut;tx=await p.pool.getDepositTransaction({walletAddress:b.wallet,amountsIn:amounts,slippage})}
    else{const directions=Object.fromEntries(assets.map(a=>[a.coinType,1n]));tx=await p.pool.getWithdrawTransaction({walletAddress:b.wallet,lpCoinAmount:lpAmount,amountsOutDirection:directions,slippage})}
  }else{
    const client=sdk();client.senderAddress=b.wallet;tx=new Transaction();
    const params={poolInfo:p.poolInfo,bankInfoA:p.bankInfoA,bankInfoB:p.bankInfoB};
    if(b.action==='deposit'){
      const [a,bAmt]=assets.map(a=>amounts[a.coinType]||0n);if(a<=0n||bAmt<=0n)fail('INVALID_AMOUNT','STEAMM deposit requires both pool assets');
      const quote=await client.Pool.quoteDeposit({...params,maxA:a,maxB:bAmt});expectedLp=quote.mintLp;minimumLp=expectedLp*BigInt(10000-slippageBps)/10000n;
      if(minimumLp<=0n)fail('INVALID_AMOUNT','Deposit too small to mint LP');
      const coinA=await naviCoinInput(tx,b.wallet,assets[0].coinType,a),coinB=await naviCoinInput(tx,b.wallet,assets[1].coinType,bAmt);
      const [lp]=await client.Pool.depositLiquidity(tx,{...params,coinA,coinB,maxA:a,maxB:bAmt});
      // Splitting and merging back enforces a minimum minted LP on-chain.
      const [minimum]=tx.splitCoins(lp,[tx.pure.u64(minimumLp)]);tx.mergeCoins(lp,[minimum]);tx.transferObjects([lp,coinA,coinB],b.wallet);
    }else{
      const quote=await client.Pool.quoteRedeem({...params,lpTokens:lpAmount});const minA=quote.withdrawA*BigInt(10000-slippageBps)/10000n,minB=quote.withdrawB*BigInt(10000-slippageBps)/10000n;
      const lpCoin=await naviCoinInput(tx,b.wallet,p.lp.coinType,lpAmount);
      await client.Pool.redeemLiquidityWithProvisionEntry(tx,{...params,lpCoin,minA,minB});
    }
  }
  const txBytes=await toBytes64(tx,b.wallet,suiSpend),sim=await devInspectB64(txBytes,b.wallet);
  if(!sim.ok)fail('SIMULATION_FAILED',String(sim.simulation?.effects?.status?.error||'LP simulation failed'));
  return{txBytes,simulation:sim.simulation,simulationStatus:'success',meta:{provider:b.provider,action:b.action,poolId:b.poolId,amounts:Object.fromEntries(Object.entries(amounts).map(([k,v])=>[k,String(v)])),lpAmount:lpAmount==null?null:String(lpAmount),expectedLp:expectedLp==null?null:String(expectedLp),minimumLp:minimumLp==null?null:String(minimumLp),slippageBps,feeCollected:null}};
}
