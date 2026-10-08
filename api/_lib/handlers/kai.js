import {handler,readJson} from '../http.js';
import {kaiVaults,kaiBuild} from '../kai.js';
export default handler(async(req,res,url)=>{
 try {
  if(req.method==='GET'&&url.pathname.endsWith('/vaults'))return await kaiVaults();
  if(req.method==='POST'&&url.pathname.endsWith('/build'))return await kaiBuild(await readJson(req));
  return {error:'NOT_FOUND',status:404};
 }catch(e){return{error:e.code||'PROVIDER_UNAVAILABLE',message:String(e.message).slice(0,260),status:/INVALID|SIMULATION|INSUFFICIENT/.test(e.code||'')?400:503};}
},{limit:30});
