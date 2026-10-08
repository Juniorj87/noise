import{journeyLeaderboard}from'../journey-ledger.js';
import{handler,readJson}from'../http.js';
import{journeyMonitor,journeyAssets,journeyAsset,journeyMarkets,journeyPositions,journeyBuild,journeyReceipt,journeyBalances}from'../journey.js';
export default handler(async(req,res,url)=>{const action=url.pathname.split('/').pop();try{
 if(req.method==='GET'){
  if(action==='leaderboard')return await journeyLeaderboard(Object.fromEntries(url.searchParams));
  if(action==='monitor')return await journeyMonitor();
  if(action==='assets')return await journeyAssets();
  if(action==='asset')return await journeyAsset(url.searchParams.get('type'));
  if(action==='markets')return{markets:await journeyMarkets(url.searchParams.get('provider')),updatedAt:new Date().toISOString()};
  if(action==='positions')return await journeyPositions(url.searchParams.get('wallet'),url.searchParams.get('provider'));
  if(action==='balances')return await journeyBalances(url.searchParams.get('wallet'));
  if(action==='receipt')return await journeyReceipt(Object.fromEntries(url.searchParams));
 }
 if(req.method==='POST'&&action==='build')return await journeyBuild(await readJson(req));
 return{error:'NOT_FOUND',status:404};
 }catch(e){return{error:e.code||'PROVIDER_UNAVAILABLE',message:String(e.message).slice(0,350),status:/INVALID|NO_POSITION|UNSUPPORTED|METADATA_MISMATCH|RECEIPT_MISMATCH/.test(e.code||'')?400:503};}
},{limit:60});
