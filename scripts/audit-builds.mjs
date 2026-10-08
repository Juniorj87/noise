// Read-only: builds and dry-runs unsigned transactions. NEVER signs or submits.
import { jsonClient, devInspectB64, suilendSupply, naviSupply, scallopSupply, haedalStakeBuild, springsuiMint, aftermathSwapBuild } from '../api/_lib/lending.js';
import { nativeStakeTx, getValidators } from '../api/_lib/earn.js';
import { writeFileSync } from 'node:fs';
const c=jsonClient();
// Validator operator addresses are public and typically less volatile than bot senders.
const validators=await getValidators();let wallet;
for(const validator of validators.validators.slice(0,40)) {
 const balance=await c.getBalance({owner:validator.suiAddress});
 if(BigInt(balance.totalBalance)>5_000_000_000n){wallet=validator.suiAddress;break;}
}
if(!wallet) throw new Error('No suitable publicly visible funded address for read-only build probe');
const v=validators.validators[0].suiAddress;
const checks={suilendSupply:()=>suilendSupply({wallet,coinType:'0x2::sui::SUI',amountMist:'100000000'}),naviSupply:()=>naviSupply({wallet,coinType:'0x2::sui::SUI',amountMist:'100000000'}),scallopSupply:()=>scallopSupply({wallet,coinName:'sui',amountMist:'100000000'}),haedalStake:()=>haedalStakeBuild({wallet,amountMist:'1000000000'}),springMint:()=>springsuiMint({wallet,amountMist:'100000000'}),nativeStake:async()=>({txBytes:await nativeStakeTx(wallet,v,1_000_000_000n)}),aftermathSwap:()=>aftermathSwapBuild({wallet,fromType:'0x2::sui::SUI',toType:'0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',amountMist:'100000000',slippage:0.01,feeBps:0})};
const results=[];
for(const [name,fn] of Object.entries(checks)){
 let timer;const at=Date.now();
 try{const r=await Promise.race([fn(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('AUDIT_TIMEOUT_45S')),45000)})]);clearTimeout(timer);const s=await devInspectB64(r.txBytes,wallet);results.push({name,built:true,simulationOk:s.ok,ms:Date.now()-at,error:s.simulation?.effects?.status?.error||null});console.log(name,'BUILT','SIM',s.ok,String(s.simulation?.effects?.status?.error||'').slice(0,160));}
 catch(e){clearTimeout(timer);results.push({name,built:false,error:String(e.message).slice(0,350),ms:Date.now()-at});console.log(name,'FAIL',String(e.message).slice(0,200))}
}
writeFileSync(new URL('../audit/build-simulations.json', import.meta.url),JSON.stringify({at:new Date().toISOString(),mode:'Public on-chain sender used for unsigned build and read-only dry-run only; no signature, no submission',results},null,2));process.exit(results.some(r => r.ok === false || r.built === false || r.simulationOk === false) ? 1 : 0);
