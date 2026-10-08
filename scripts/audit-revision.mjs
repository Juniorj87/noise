import {Transaction}from'@mysten/sui/transactions';
import {VAULTS}from'@kunalabs-io/kai';
import {getValidators}from'../api/_lib/earn.js';
import {jsonClient,grpcClient,toBytes64,devInspectB64}from'../api/_lib/lending.js';
import {cetusAdapter}from'../api/_lib/adapters.js';
import {getRevenueWallet,sumSuiInbound,scanRevenueWallet}from'../api/_lib/revenue-wallet.js';
import {kaiBuild}from'../api/_lib/kai.js';
import {writeFileSync}from'node:fs';
const c=jsonClient(),vs=await getValidators();let wallet;
for(const v of vs.validators.slice(0,40)){if(BigInt((await c.getBalance({owner:v.suiAddress})).totalBalance)>5_000_000_000n){wallet=v.suiAddress;break;}}
const results=[];async function check(name,fn){try{const r=await fn();const sim=await devInspectB64(r.txBytes,wallet);const observed=sumSuiInbound(sim.simulation?.balanceChanges,getRevenueWallet());const result={name,ok:sim.ok,fee:r.feeCollected||r.meta?.feeCollected||null,recipientSuiCredit:String(observed),error:sim.simulation?.effects?.status?.error||null};results.push(result);console.log(JSON.stringify(result));}catch(e){results.push({name,ok:false,error:e.message});console.log(name,e.message)}}
await check('cetus-fee',()=>cetusAdapter.buildSwap({from:'SUI',to:'USDC',sender:wallet,amountMist:'100000000',slippage:0.01}));
await check('kai-deposit',()=>kaiBuild({wallet,vault:'SUI',action:'deposit',amountMist:'100000000'}));
await check('kai-atomic-deposit-redeem',async()=>{const v=VAULTS.SUI,tx=new Transaction();const[sui]=tx.splitCoins(tx.gas,[tx.pure.u64(100000000n)]);const bal=tx.moveCall({target:'0x2::coin::into_balance',typeArguments:[v.T.typeName],arguments:[sui]});const yt=v.deposit(tx,bal);const out=v.withdraw(tx,yt,v.getStrategies());const coin=tx.moveCall({target:'0x2::coin::from_balance',typeArguments:[v.T.typeName],arguments:[out]});tx.transferObjects([coin],wallet);return{txBytes:await toBytes64(tx,wallet,100000000n)}});
const scan=await scanRevenueWallet();console.log('revenue',JSON.stringify(scan));writeFileSync('audit/revision-execution.json',JSON.stringify({at:new Date().toISOString(),mode:'Unsigned simulation only, no submission',results,revenueScan:scan},null,2));process.exit(results.some(r=>!r.ok)?1:0);
