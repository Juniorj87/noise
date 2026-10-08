import * as lend from '../api/_lib/lending.js';
import { PROTOCOLS } from '../shared/registry.js';
import { writeFileSync } from 'node:fs';
const checks={suilendMarkets:()=>lend.suilendMarkets(),naviMarkets:()=>lend.naviMarkets(),scallopMarkets:()=>lend.scallopMarkets(),bucketMarkets:()=>lend.bucketMarkets(),springsuiRate:()=>lend.springsuiRate(),haedalRate:()=>lend.haedalRate(),turbosPools:()=>lend.turbosPools(10),bluefinMarkets:()=>lend.bluefinMarkets(),voloStats:()=>lend.voloStats()};
const results=[];
await Promise.all(Object.entries(checks).map(async([name,fn])=>{
 const begin=Date.now();let t;
 try{const value=await Promise.race([fn(),new Promise((_,reject)=>{t=setTimeout(()=>reject(new Error('AUDIT_TIMEOUT_35S')),35000)})]);results.push({name,ok:true,ms:Date.now()-begin,value}); console.log(name,'OK',Array.isArray(value)?value.length:Object.keys(value));}
 catch(e){results.push({name,ok:false,ms:Date.now()-begin,error:String(e.message)});console.log(name,'FAIL',String(e.message).slice(0,180));}finally{clearTimeout(t)}
}));
writeFileSync(new URL('../audit/live-reads.json', import.meta.url),JSON.stringify({at:new Date().toISOString(),results,registry:PROTOCOLS},null,2));process.exit(results.some(r => r.ok === false || r.built === false || r.simulationOk === false) ? 1 : 0);
