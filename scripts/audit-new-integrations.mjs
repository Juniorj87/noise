// Read-only contract and venue probes: no private keys, signatures or submissions.
import {Transaction} from '@mysten/sui/transactions';
import {voloBuild,voloMove,turbosSwapBuild} from '../api/_lib/protocol-execution.js';
import {jsonClient,toBytes64,devInspectB64} from '../api/_lib/lending.js';
import {cetusAdapter} from '../api/_lib/adapters.js';
import {getValidators} from '../api/_lib/earn.js';
import {ROUTED_VENUES} from '../shared/routed-venues.js';
import {writeFileSync} from 'node:fs';
const c=jsonClient(),validators=await getValidators();let wallet;
for(const v of validators.validators.slice(0,40)){if(BigInt((await c.getBalance({owner:v.suiAddress})).totalBalance)>5_000_000_000n){wallet=v.suiAddress;break}}
if(!wallet)throw new Error('No publicly visible funded sender for read-only probe');
const swap={wallet,fromType:'0x2::sui::SUI',toType:'0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',amountMist:'100000000',slippage:0.01};
const checks={voloStake:()=>voloBuild({wallet,amountMist:'1000000000',action:'stake'}),voloStakeAndRedeem:async()=>{const tx=new Transaction();const [sui]=tx.splitCoins(tx.gas,[tx.pure.u64(1000000000n)]);const [vsui]=voloMove(tx,'stake',sui);const [redeemed]=voloMove(tx,'unstake',vsui);tx.transferObjects([redeemed],wallet);return {txBytes:await toBytes64(tx,wallet,1000000000n)}},turbosSwap:()=>turbosSwapBuild(swap),...Object.fromEntries(Object.keys(ROUTED_VENUES).filter(v=>v!=='steamm').map(venue=>[venue+'Swap',()=>cetusAdapter.buildSwap({from:'SUI',to:'USDC',amountMist:'100000000',sender:wallet,slippage:0.01,venue})]))};
const results=[];
for(const[name,fn]of Object.entries(checks)){const at=Date.now();let t;try{const r=await Promise.race([fn(),new Promise((_,reject)=>{t=setTimeout(()=>reject(new Error('AUDIT_TIMEOUT_60S')),60000)})]);clearTimeout(t);const sim=await devInspectB64(r.txBytes,wallet);const row={name,built:true,simulationOk:sim.ok,ms:Date.now()-at,error:sim.simulation?.effects?.status?.error||null};results.push(row);console.log(JSON.stringify(row));if(r.router)row.routeProviders=[...new Set(r.router.paths.map(p=>p.provider))];}catch(e){clearTimeout(t);const row={name,built:false,error:String(e.message).slice(0,400),ms:Date.now()-at};results.push(row);console.log(JSON.stringify(row))}}
writeFileSync(new URL('../audit/new-integrations.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),mode:'Unsigned build and read-only simulation; no signing/submission',results},null,2));process.exit(results.some(r=>!r.built||!r.simulationOk)?1:0);
