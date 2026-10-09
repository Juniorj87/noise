import{extendedMarkets,extendedPositions,extendedDeposit,extendedWithdraw,claimHaedal}from'./journey-extension.js';
import{jpMarkets,jpPositions,jpDeposit,jpWithdraw}from'./journey-providers.js';
import{registerJourneyBuild,recordJourneyReceipt}from'./journey-ledger.js';
// Atomic in-hub swap -> deposit; real positions -> withdrawal. Never signs/submits.
import {Transaction} from '@mysten/sui/transactions';
import {normalizeStructTag} from '@mysten/sui/utils';
import {VAULTS,calcYtToTAmount} from '@kunalabs-io/kai';
import {MAINNET_ASSETS,ASSET_BY_SYMBOL} from '../../shared/assets.js';
import {validateJourney,fail,rawHuman,humanRaw,scaledNaviRaw,checkReceipt,riskLabel} from '../../shared/journey-model.js';
import {grpcClient,jsonClient,naviCoinInput,toBytes64,devInspectB64,isWalletAddress,suilendMarkets,suilendPosition,naviMarkets,naviPosition,journeySuilendDeposit,journeySuilendWithdraw,journeyNaviDeposit,journeyNaviWithdraw} from './lending.js';
import {sui,cetusSwapCoin} from './adapters.js';
import {kaiVaults} from './kai.js';
import {NETWORK} from './sui-provider.js';
import {cached} from './util.js';
const canonical=t=>normalizeStructTag(t);
async function retry(fn){for(let n=0;;n++)try{return await fn();}catch(e){if(n>=2||!/429|timeout|fetch failed|unavailable/i.test(e.message))throw e;await new Promise(r=>setTimeout(r,700*(n+1)));}}
export async function journeyAsset(value,fb){
  const known=ASSET_BY_SYMBOL[String(value).toUpperCase()]||MAINNET_ASSETS.find(a=>a.coinType===value);
  const type=known?.coinType||value;
  if(!/^0x[\da-fA-F]{1,64}::[A-Za-z_]\w*::[A-Za-z_]\w*$/.test(type||''))fail('UNSUPPORTED_ASSET','Select a known token or a full coin type.');
  return cached('journey:metadata:'+canonical(type),300000,async()=>{let m=null;try{const res=await retry(()=>grpcClient().getCoinMetadata({coinType:type}));m=res.coinMetadata;}catch(e){m=null;}
    if((!m||!Number.isInteger(m.decimals)||m.decimals<0||m.decimals>18)&&fb&&Number.isInteger(fb.decimals)&&fb.decimals>=0&&fb.decimals<=18)return{symbol:fb.symbol||known?.symbol||type.split('::').pop(),name:fb.symbol||known?.symbol||'',coinType:canonical(type),decimals:fb.decimals,source:'Provider market decimals; on-chain Metadata object missing'};
    if(!m||!Number.isInteger(m.decimals)||m.decimals<0||m.decimals>18)fail('METADATA_UNAVAILABLE','On-chain token decimals unavailable.');
    if(known&&known.decimals!==m.decimals)fail('METADATA_MISMATCH','Token registry decimals differ from chain.');
    return{symbol:known?.symbol||m.symbol||type.split('::').pop(),name:m.name||known?.symbol||'',coinType:canonical(type),decimals:m.decimals,source:'On-chain CoinMetadata; identity is coin type, not ticker'};
  });
}
let assetsLoading=null;
export async function journeyAssets(){return cached('journey:assets',60000,async()=>{if(!assetsLoading)assetsLoading=(async()=>{const rows=[],unavailable=[];for(let i=0;i<MAINNET_ASSETS.length;i+=3){const batch=await Promise.allSettled(MAINNET_ASSETS.slice(i,i+3).map(a=>journeyAsset(a.symbol)));batch.forEach((r,n)=>r.status==='fulfilled'?rows.push(r.value):unavailable.push({symbol:MAINNET_ASSETS[i+n].symbol,error:r.reason.code||'METADATA_UNAVAILABLE'}));}return{assets:rows,unavailable,source:'Curated ecosystem list; chain metadata verified; not a ranking',updatedAt:new Date().toISOString()};})().finally(()=>assetsLoading=null);return assetsLoading;});}
export async function journeyMarkets(provider){
  if(!['suilend','navi','kai','scallop','haedal','springsui','metastable','volo'].includes(provider))fail('INVALID_PROVIDER');
  if(['scallop','haedal'].includes(provider))return retry(()=>extendedMarkets(provider));
  if(['springsui','metastable','volo'].includes(provider))return retry(()=>jpMarkets(provider));
 if(provider==='kai'){const r=await retry(()=>kaiVaults());return r.vaults.map(v=>({provider,id:v.name,vault:v.name,coinType:canonical(v.coinType),symbol:v.name,decimals:v.decimals,rate:v.apyPercent,rateKind:'APY',rateBasis:'Kai vault strategy rate, variable',performanceFeeBps:v.feeBps,baseRate:v.aprPercent,baseRateKind:'APR',rewardRate:null,rewardRateKind:null,rewardNote:'No independently quantified incentive component in this response; not assumed zero',availableLiquidity:null,withdrawTerms:'Redeem vault shares to the underlying asset; output depends on current vault state, strategy liquidity and simulation',source:v.source,updatedAt:v.updatedAt}));}
 const rows=await retry(()=>provider==='suilend'?suilendMarkets():naviMarkets());return rows.filter(m=>!m.deprecated&&m.coinType&&Number.isInteger(m.decimals)).map(m=>({provider,id:String(m.id??canonical(m.coinType)),pool:m.id,coinType:canonical(m.coinType),symbol:MAINNET_ASSETS.find(a=>canonical(a.coinType)===canonical(m.coinType))?.symbol||m.symbol,decimals:m.decimals,rate:m.depositApr??m.supplyApy??m.supplyApr??null,rateKind:provider==='suilend'?'APR':m.supplyApy!=null?'APY':'APR',rateBasis:m.rateBasis,baseRate:provider==='suilend'?m.depositApr:m.supplyApr,baseRateKind:'APR',rewardRate:provider==='navi'&&m.supplyIncentives?.boostedApr!=null&&Number.isFinite(Number(m.supplyIncentives.boostedApr))?Number(m.supplyIncentives.boostedApr):null,rewardRateKind:provider==='navi'?'APR':null,rewardNote:provider==='navi'?'Provider boost APR; not added to APY by Noise':'Rewards not quantified in this response; base interest only, not assumed zero',availableLiquidity:provider==='suilend'?m.available:null,withdrawTerms:'Withdrawal depends on current reserve liquidity and debt/collateral health; a fresh full transaction simulation is required',source:m.source,updatedAt:m.updatedAt}));
}
export async function journeyPositions(wallet,provider){
 if(!isWalletAddress(wallet))fail('INVALID_WALLET');const markets=await journeyMarkets(provider),rows=[];
  if(['scallop','haedal'].includes(provider))return retry(()=>extendedPositions(wallet,provider,markets));
  if(['springsui','metastable','volo'].includes(provider)){const r=await retry(()=>jpPositions(wallet,provider));return{provider,positions:r.positions,complete:r.complete,errors:[],source:'Wallet receipt-token balance (live read)',updatedAt:new Date().toISOString()};}
 if(provider==='suilend'){const r=await retry(()=>suilendPosition(wallet));for(const ob of r.obligations){const debt=Number(ob.borrowedUsd)>0;
  for(const d of ob.deposits){const m=markets.find(m=>m.coinType===canonical(d.coinType));if(!m)continue;const amountRaw=humanRaw(d.amount,m.decimals);rows.push({id:ob.obligationId+':'+m.coinType,provider,marketId:m.id,obligationId:ob.obligationId,asset:m.symbol,coinType:m.coinType,decimals:m.decimals,amountRaw,amountHuman:rawHuman(amountRaw,m.decimals),amountUsd:d.amountUsd,withdrawUnit:m.symbol,debt,borrowedUsd:ob.borrowedUsd,health:ob.health,healthBasis:ob.healthBasis,risk:riskLabel(debt,ob.health),canWithdraw:BigInt(amountRaw)>0n&&( !debt||Number.isFinite(ob.health)&&ob.health>1),source:r.source,updatedAt:r.updatedAt});}}
  return{provider,positions:rows,complete:r.complete,errors:r.errors,updatedAt:r.updatedAt,source:r.source};
 }
 if(provider==='navi'){const r=await retry(()=>naviPosition(wallet));const debt=(r.positions||[]).some(p=>BigInt(scaledNaviRaw(p.borrowBalance, p.pool?.token?.decimals??9))>0n);
  for(const p of r.positions||[]){const m=markets.find(m=>Number(m.pool)===Number(p.assetId)&&m.coinType===canonical(p.pool?.suiCoinType||p.pool?.coinType||''));if(!m)continue;const amountRaw=scaledNaviRaw(p.supplyBalance,m.decimals);if(BigInt(amountRaw)<=0n)continue;const supported=!p.emodeId&&(!p.market||p.market==='main');rows.push({id:String(p.market)+':'+p.assetId+':'+(p.emodeId??''),provider,marketId:m.id,pool:p.assetId,coinType:m.coinType,asset:m.symbol,decimals:m.decimals,amountRaw,amountHuman:rawHuman(amountRaw,m.decimals),amountUsd:null,withdrawUnit:m.symbol,debt,health:r.healthFactor,healthBasis:'NAVI SDK liquidation health',risk:riskLabel(debt,r.healthFactor),canWithdraw:supported&&(!debt||Number.isFinite(r.healthFactor)&&r.healthFactor>1),restriction:supported?null:'Non-default NAVI market/eMode requires its specific adapter',source:r.source,updatedAt:r.updatedAt});}
  return{provider,positions:rows,complete:true,errors:[],source:r.source,updatedAt:r.updatedAt};
 }
 if(provider==='kai'){for(const name of ['SUI','USDC']){const info=VAULTS[name],state=await retry(()=>info.fetch(grpcClient()));const b=await retry(()=>sui.getBalance(wallet,info.YT.typeName));const raw=String(b.value?.totalBalance??'0');if(BigInt(raw)<=0n)continue;const underlying=String(calcYtToTAmount(info,state,BigInt(raw)));rows.push({id:name,provider,vault:name,marketId:name,asset:name,coinType:canonical(info.T.typeName),decimals:info.YT.decimals,amountRaw:raw,amountHuman:rawHuman(raw,info.YT.decimals),underlyingRaw:underlying,underlyingHuman:rawHuman(underlying,info.T.decimals),inputType:canonical(info.YT.typeName),withdrawUnit:info.YT.symbol||'y'+name,debt:false,health:null,risk:'No wallet-level borrowing · vault strategy, contract and liquidity risks remain',canWithdraw:true,performanceFeeBps:String(state.performanceFeeBps),source:'Kai vault state + wallet share balance',updatedAt:new Date().toISOString()});}return{provider,positions:rows,complete:true,errors:[],source:'Kai SDK + Sui',updatedAt:new Date().toISOString()};}
 fail('INVALID_PROVIDER');
}
export async function journeyBuild(input){
 if(NETWORK!=='mainnet')fail('NETWORK_MISMATCH');const b=validateJourney(input);let tx=new Transaction();let market=null;let from=null,to=null;
 if(b.action!=='swap'){const markets0=await journeyMarkets(b.provider);const fbFor=(coin)=>{const mm=markets0.find(m=>{try{return canonical(m.coinType)===canonical(coin);}catch{return String(m.coinType)===String(coin);}});return mm&&Number.isInteger(mm.decimals)?{decimals:mm.decimals,symbol:mm.symbol}:null;};from=await journeyAsset(b.from,fbFor(b.from));to=await journeyAsset(b.to,fbFor(b.to));const coinForms=(v)=>{const out=[String(v).toLowerCase()];try{out.push(canonical(String(v)).toLowerCase());}catch{}return out;};const wantCoinForms=coinForms(b.action==='enter'?to.coinType:from.coinType);const wantIdForms=coinForms(b.marketId);market=markets0.find(m=>coinForms(m.id).some(x=>wantIdForms.includes(x)||String(x)===String(b.marketId).toLowerCase())&&coinForms(m.coinType).some(x=>wantCoinForms.includes(x)));if(!market)fail('INVALID_MARKET','This token is not supported by the selected deposit market.');}else{from=await journeyAsset(b.from);to=await journeyAsset(b.to);}
let position=null;
 let inputCoin,quote=null,actualDeposit=null,extensionMeta=null;
 if(b.action==='claim'){await claimHaedal(tx,b.wallet,b.ticketId);extensionMeta={note:'Claims an owned Haedal unstake ticket; only succeeds after unlock. No input coin is spent.'};}
 else if(b.action==='withdraw'){
   const current=await journeyPositions(b.wallet,b.provider);if(!current.complete)fail('POSITION_UNAVAILABLE','Incomplete position read; withdrawal blocked.');position=current.positions.find(p=>p.id===b.positionId&&p.marketId===market.id);
   if(!position||!position.canWithdraw)fail('NO_POSITION','Position unavailable or health/market restrictions prevent withdrawal.');if(BigInt(b.amountMist)>BigInt(position.amountRaw))fail('INVALID_AMOUNT','Withdrawal exceeds the selected position.');
   if(b.provider==='suilend')inputCoin=await journeySuilendWithdraw(tx,b.wallet,from.coinType,b.amountMist,position.obligationId);
   else if(b.provider==='navi')inputCoin=await journeyNaviWithdraw(tx,from.coinType,b.amountMist,market.pool,b.wallet);
    else if(['scallop','haedal'].includes(b.provider)){extensionMeta=await extendedWithdraw(tx,b.wallet,b.provider,position,market,b.amountMist,b.exitMode||'delayed');tx=extensionMeta.transaction||tx;inputCoin=extensionMeta.coin;}
    else if(['springsui','metastable','volo'].includes(b.provider)){extensionMeta=await jpWithdraw(tx,b.wallet,b.provider,position,market,b.amountMist);tx=extensionMeta.transaction||tx;inputCoin=extensionMeta.coin;}
   else {const v=VAULTS[market.vault],share=await naviCoinInput(tx,b.wallet,v.YT.typeName,b.amountMist);const bal=tx.moveCall({target:'0x2::coin::into_balance',typeArguments:[v.YT.typeName],arguments:[share]});const out=v.withdraw(tx,bal,v.getStrategies());inputCoin=tx.moveCall({target:'0x2::coin::from_balance',typeArguments:[v.T.typeName],arguments:[out]});}
   // Exits return the underlying asset. No speculative swap of unquoted vault redemption output.
   if(from.coinType!==to.coinType)fail('INVALID_ASSET','Withdraw to the underlying asset; a separate reviewed swap can follow.');
   if(inputCoin)tx.transferObjects([inputCoin],tx.pure.address(b.wallet));
 }else{
    inputCoin=b.provider==='metastable'?null:await naviCoinInput(tx,b.wallet,from.coinType,b.amountMist);
    if(b.provider==='metastable'&&from.coinType!==to.coinType)fail('INVALID_ACTION','mSUI mints direct from SUI only — use Swap-only mode first, then mint.');
    if(from.coinType!==to.coinType){const r=await cetusSwapCoin({txb:tx,inputCoin,fromType:from.coinType,toType:to.coinType,amountMist:b.amountMist,fromSymbol:from.symbol,toSymbol:to.symbol,slippageBps:b.slippageBps});inputCoin=r.outputCoin;quote=r.quote;}else if(b.action==='swap')fail('INVALID_ASSET','Choose different swap assets.');
    if(b.action==='enter'){
     actualDeposit=inputCoin?tx.moveCall({target:'0x2::coin::value',typeArguments:[to.coinType],arguments:[inputCoin]}):null;
     if(b.provider==='suilend')await journeySuilendDeposit(tx,b.wallet,to.coinType,inputCoin,b.obligationId);
     else if(b.provider==='navi')await journeyNaviDeposit(tx,to.coinType,inputCoin,market.pool);
     else if(['scallop','haedal'].includes(b.provider)){extensionMeta=await extendedDeposit(tx,b.wallet,b.provider,market,inputCoin,quote,b.amountMist,b.slippageBps);tx=extensionMeta.transaction||tx;}
     else if(['springsui','metastable','volo'].includes(b.provider)){extensionMeta=await jpDeposit(tx,b.wallet,b.provider,market,{inputCoin,fromCoinType:from.coinType,amountMist:b.amountMist});tx=extensionMeta.transaction||tx;}
    else{const v=VAULTS[market.vault];await retry(()=>v.fetch(grpcClient()));const bal=tx.moveCall({target:'0x2::coin::into_balance',typeArguments:[v.T.typeName],arguments:[inputCoin]});const share=v.deposit(tx,bal);const out=tx.moveCall({target:'0x2::coin::from_balance',typeArguments:[v.YT.typeName],arguments:[share]});tx.transferObjects([out],tx.pure.address(b.wallet));}
   }else tx.transferObjects([inputCoin],tx.pure.address(b.wallet));
 }
 const txBytes=await toBytes64(tx,b.wallet,['enter','swap'].includes(b.action)&&from.symbol==='SUI'?b.amountMist:0n);const sim=await retry(()=>devInspectB64(txBytes,b.wallet));if(!sim.ok)fail('SIMULATION_FAILED','No signable transaction: '+String(sim.simulation?.effects?.status?.error||'simulation unavailable').slice(0,230));
 const digest=await Transaction.from(Buffer.from(txBytes,'base64')).getDigest();
 const built={txBytes,expectedDigest:digest,simulation:sim.simulation,simulationStatus:'success',builtAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),meta:{action:b.action,provider:b.action==='swap'?'cetus':b.provider,wallet:b.wallet,from,to,amountMist:b.action==='claim'?'0':b.amountMist,inputAsset:position?.inputType?{coinType:position.inputType,symbol:position.withdrawUnit,decimals:position.decimals}:from,extensionMeta:extensionMeta?Object.fromEntries(Object.entries(extensionMeta).filter(([k])=>!['coin','transaction'].includes(k))):null,marketId:market?.id||null,positionId:position?.id||null,atomic:true,steps:b.action==='enter'?[...(quote?['swap']:[]),'deposit']:[b.action].filter(()=>['withdraw','claim'].includes(b.action)).concat(b.action==='swap'?['swap']:[]),quote,rate:market?.rate??null,rateKind:market?.rateKind||null,withdrawTerms:market?.withdrawTerms||null,performanceFeeBps:market?.performanceFeeBps??null,feeCollected:quote?.feeCollected||null,positionRisk:position?.risk||null,healthBefore:position?.health??null,healthAfter:null,healthAfterNote:'Full execution simulated; no invented post-action health ratio',depositAmountBasis:b.action==='enter'?'Actual swap output Coin is deposited, not an estimated quantity':null}};
 try{await registerJourneyBuild(built);built.activityTracking='prepared digest recorded';}catch{built.activityTracking='unavailable: receipt is still checked, but ranking is not credited without prepared-digest accounting';}
 return built;
}
export async function journeyReceipt({wallet,digest,expectedDigest}){
 if(!isWalletAddress(wallet))fail('INVALID_WALLET');if(!/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(digest||'')||digest!==expectedDigest)fail('RECEIPT_MISMATCH','Wallet digest differs from the reviewed transaction; inspect wallet history.');
 let tx;try{tx=await jsonClient().getTransactionBlock({digest,options:{showInput:true,showEffects:true,showBalanceChanges:true}});}catch(e){if(/not found|could not find|not yet|unknown transaction/i.test(e.message))return{status:'pending',digest,source:'Sui receipt lookup',updatedAt:new Date().toISOString()};fail('RECEIPT_UNAVAILABLE','Receipt unavailable. Do not submit again; retry lookup.');}
 const receipt=checkReceipt(tx,wallet,expectedDigest);let activityRecorded=false;try{activityRecorded=await recordJourneyReceipt(receipt,wallet);}catch{}
 return{...receipt,activityRecorded,source:'Sui transaction receipt; sender + digest + effects verified',updatedAt:new Date().toISOString()};
}
export async function journeyBalances(wallet){if(!isWalletAddress(wallet))fail('INVALID_WALLET');const r=await sui.getBalances(wallet);return{balances:r.value,source:r.source,updatedAt:r.updatedAt};}

export async function journeyMonitor(){return cached('journey:monitor',30000,async()=>{const probes=[['Sui RPC',()=>jsonClient().getLatestCheckpointSequenceNumber()],...['suilend','navi','kai','scallop','haedal','springsui','metastable','volo'].map(p=>[p,()=>journeyMarkets(p)])];const checks=await Promise.all(probes.map(async([provider,fn])=>{const began=Date.now();let timer;try{const value=await Promise.race([fn(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Read timed out')),15000);})]);if(Array.isArray(value)&&!value.length)throw new Error('No usable markets');return{provider,status:'available',latencyMs:Date.now()-began,checkedAt:new Date().toISOString(),detail:Array.isArray(value)?value.length+' markets reported':'Checkpoint '+value};}catch{return{provider,status:'unavailable',latencyMs:Date.now()-began,checkedAt:new Date().toISOString(),detail:'Read failed or timed out. Not evidence that the protocol itself is down.'};}finally{clearTimeout(timer);}}));return{checks,updatedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),scope:'Read probes for eight placement providers and Sui RPC only; not an independent security audit, route guarantee or funded execution test'};});}
