// Public wallet state is used only for unsigned read-only simulation.
import{Transaction}from'@mysten/sui/transactions';
import{SteammSDK,MAINNET_CONFIG}from'@suilend/steamm-sdk';
import{getValidators}from'../api/_lib/earn.js';
import{grpcClient,jsonClient,naviCoinInput,toBytes64,devInspectB64}from'../api/_lib/lending.js';
import{liquidityPools,liquidityPool,liquidityBuild,resolvePool}from'../api/_lib/liquidity.js';
import{normalizeStructTag}from'@mysten/sui/utils';
import{writeFileSync}from'node:fs';
const SUI='0x2::sui::SUI',USDC='0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const c=jsonClient();let wallet,usdcWallet;for(const v of(await getValidators()).validators.slice(0,40)){if(BigInt((await c.getBalance({owner:v.suiAddress})).totalBalance)>5_000_000_000n){wallet ||=v.suiAddress;if(BigInt((await c.getBalance({owner:v.suiAddress,coinType:USDC})).totalBalance)>1000000n){usdcWallet=v.suiAddress;break}}}
if(!wallet)throw new Error('No funded publicly visible sender for dry-run');
const results=[];async function check(name,fn){try{const r=await fn();const result={name,built:!!r.txBytes,simulationOk:r.simulationStatus==='success',meta:r.meta};results.push(result);console.log(name,result.built,result.simulationOk)}catch(e){results.push({name,built:false,error:String(e.message).slice(0,450)});console.log(name,'FAIL',e.message)}}
await check('aftermathLpDeposit',async()=>{const rows=(await liquidityPools('aftermath')).pools;for(const p of rows.filter(p=>/SUI/i.test(p.name))){const m=await liquidityPool('aftermath',p.poolId);const a=m.assets.find(a=>normalizeStructTag(a.coinType)===normalizeStructTag(SUI));if(a)return liquidityBuild({provider:'aftermath',poolId:p.poolId,wallet,action:'deposit',amounts:{[a.coinType]:'1'},slippageBps:100})}throw new Error('No active SUI pool')});
await check('steammLpDeposit',async()=>{
 if(!usdcWallet)throw new Error('No sampled public sender holds both assets');
 const poolId=(await liquidityPools('steamm')).pools[0].poolId;const p=await liquidityPool('steamm',poolId);
 return liquidityBuild({provider:'steamm',poolId,wallet:usdcWallet,action:'deposit',amounts:{[p.assets[0].coinType]:'0.1',[p.assets[1].coinType]:'0.1'},slippageBps:100});
});
await check('steammLpDepositAndWithdraw',async()=>{
 if(!usdcWallet)throw new Error('No sampled public sender holds USDC and SUI; LP dry-run not tested');
 const poolId=(await liquidityPools('steamm')).pools[0].poolId;const p=await resolvePool('steamm',poolId);console.log('steammAssets',p.assets.map(a=>a.symbol));
 const s=new SteammSDK({...MAINNET_CONFIG,grpcClient:grpcClient(),graphqlUrl:'https://graphql.mainnet.sui.io/graphql'});s.senderAddress=usdcWallet;
 const tx=new Transaction();const a=await naviCoinInput(tx,usdcWallet,p.assets[0].coinType,100000000n),b=await naviCoinInput(tx,usdcWallet,p.assets[1].coinType,100000n),params={poolInfo:p.poolInfo,bankInfoA:p.bankInfoA,bankInfoB:p.bankInfoB};
 const [lp]=await s.Pool.depositLiquidity(tx,{...params,coinA:a,coinB:b,maxA:100000000n,maxB:100000n});
 await s.Pool.redeemLiquidityWithProvisionEntry(tx,{...params,lpCoin:lp,minA:0n,minB:0n});tx.transferObjects([a,b],usdcWallet);
 const txBytes=await toBytes64(tx,usdcWallet,100000000n),sim=await devInspectB64(txBytes,usdcWallet);if(!sim.ok)throw new Error(sim.simulation?.effects?.status?.error||'Dry-run failed');return{txBytes,simulationStatus:'success',meta:{poolId,roundTrip:true}};
});
writeFileSync(new URL('../audit/liquidity-simulations.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),mode:'Read-only, no signing/submission; round-trip minOut=0 only in audit, production builders enforce quoted minima',results},null,2));process.exit(results.some(r=>!r.built||!r.simulationOk)?1:0);
