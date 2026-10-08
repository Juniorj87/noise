import { VAULTS, getVaultStats } from '@kunalabs-io/kai';
import { Transaction } from '@mysten/sui/transactions';
import { grpcClient, naviCoinInput, toBytes64, devInspectB64, isWalletAddress } from './lending.js';
import { positiveU64 } from '../../shared/execution-math.js';
import {cached} from './util.js';
import { NETWORK } from './sui-provider.js';
const available = ['SUI','USDC'];
function vaultFor(name) {
  if(NETWORK!=='mainnet'||!available.includes(name))throw Object.assign(new Error('Unsupported vault'),{code:'INVALID_MARKET'});
  return VAULTS[name];
}
async function retryRead(fn) { for(let attempt=0; ;attempt++){try{return await fn();}catch(e){if(attempt>=2||!/429|timeout|network|fetch failed/i.test(e.message))throw e;await new Promise(r=>setTimeout(r,800*(attempt+1)));}} }
export async function kaiVaults() {
  return cached('kai-vaults:mainnet',15000,async()=>({provider:'kai',vaults:await Promise.all(available.map(async name=>{
    const info=vaultFor(name),state=await retryRead(()=>info.fetch(grpcClient())),stats=getVaultStats(state);
    return {name,id:info.id,coinType:info.T.typeName,ytType:info.YT.typeName,decimals:info.T.decimals,ytDecimals:info.YT.decimals,tvlRaw:String(stats.tvl.int),aprPercent:stats.apr*100,apyPercent:stats.apy*100,feeBps:String(state.performanceFeeBps),tvlCap:state.tvlCap==null?null:String(state.tvlCap),source:'Kai SDK + on-chain vault',updatedAt:new Date().toISOString()};
  }))}));
}
export async function kaiMove(tx,wallet,name,action,amountMist) {
  const info=vaultFor(name),state=await retryRead(()=>info.fetch(grpcClient()));
  if(!['deposit','withdraw'].includes(action))throw Object.assign(new Error('Invalid vault action'),{code:'INVALID_ACTION'});
  const amount=positiveU64(amountMist);
  // Only current SUI/USDC vault IDs are allowed; legacy paused vaults are not selectable.
  const coin=await naviCoinInput(tx,wallet,action==='deposit'?info.T.typeName:info.YT.typeName,amount);
  const balance=tx.moveCall({target:'0x2::coin::into_balance',typeArguments:[action==='deposit'?info.T.typeName:info.YT.typeName],arguments:[coin]});
  const strategies=info.getStrategies();
  // Official SDK strategy objects are verified through full simulation; vault
  // state keys are policy state IDs, not the strategy shared-object IDs.
  const output=action==='deposit'?info.deposit(tx,balance):info.withdraw(tx,balance,strategies);
  const result=tx.moveCall({target:'0x2::coin::from_balance',typeArguments:[action==='deposit'?info.YT.typeName:info.T.typeName],arguments:[output]});
  tx.transferObjects([result],wallet);
  return {info,state};
}
export async function kaiBuild({wallet,vault='SUI',action,amountMist}) {
  if(!isWalletAddress(wallet))throw Object.assign(new Error('Invalid wallet'),{code:'INVALID_WALLET'});
  const tx=new Transaction();const {info}=await kaiMove(tx,wallet,vault,action,amountMist);
  const txBytes=await toBytes64(tx,wallet,action==='deposit'&&vault==='SUI'?amountMist:0n);
  const simulation=await retryRead(()=>devInspectB64(txBytes,wallet));
  if(!simulation.ok)throw Object.assign(new Error('Vault transaction simulation failed: '+JSON.stringify(simulation.simulation?.effects?.status||{})),{code:'SIMULATION_FAILED'});
  return {txBytes,simulation:simulation.simulation,simulationStatus:'success',meta:{provider:'kai',vault,action,amountMist:String(amountMist),inputType:action==='deposit'?info.T.typeName:info.YT.typeName,feeCollected:null}};
}
