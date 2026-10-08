import {handler,readJson} from '../http.js';
import {liquidityPools,liquidityPool,liquidityBuild} from '../liquidity.js';
export default handler(async(req,res,url)=>{
 try{
  if(req.method==='GET' && url.pathname.endsWith('/pools'))return await liquidityPools(url.searchParams.get('provider')||'aftermath');
  if(req.method==='GET' && url.pathname.endsWith('/pool'))return await liquidityPool(url.searchParams.get('provider')||'aftermath',url.searchParams.get('poolId'));
  if(req.method==='POST' && url.pathname.endsWith('/build'))return await liquidityBuild(await readJson(req));
  return{error:'NOT_FOUND',status:404};
 }catch(e){return{error:e.code||'PROVIDER_UNAVAILABLE',message:String(e.message).slice(0,260),status:/INVALID|SIMULATION|INSUFFICIENT/.test(e.code||'')?400:502}}
},{limit:30});
