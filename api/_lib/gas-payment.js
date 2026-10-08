// Bound gas inputs for fragmented wallets. No keys, signatures or submissions.
// The SDK's automatic selection can exceed the chain's 256-object gas limit.
export async function boundedGasPayment(tx, owner, client, suiSpendMist = 0n) {
  if (tx.getData().gasData.payment?.length) return;
  const used = new Set(tx.getData().inputs.map(input => {
    const o = input.Object;
    return input.UnresolvedObject?.objectId ?? o?.ImmOrOwnedObject?.objectId ?? o?.Receiving?.objectId;
  }).filter(Boolean));
  const coins=[]; let cursor=null;
  do {
    const page=await client.getCoins({ owner, coinType:'0x2::sui::SUI', cursor, limit:100 });
    coins.push(...(page.data || []).filter(c => !used.has(c.coinObjectId) && BigInt(c.balance || 0)>0n));
    if(!page.hasNextPage)break;
    if(!page.nextCursor || page.nextCursor===cursor || coins.length>5000) throw Object.assign(new Error('Wallet coin pagination limit reached; consolidate coins before retrying.'),{code:'PROVIDER_UNAVAILABLE'});
    cursor=page.nextCursor;
  }while(cursor);
  coins.sort((a,b)=>BigInt(a.balance)===BigInt(b.balance)?0:BigInt(a.balance)>BigInt(b.balance)?-1:1);
  // Sui address-balance wallets may have no Coin<SUI> objects at all.
  // Let the SDK use FundsWithdrawal instead of rejecting a funded wallet.
  if(!coins.length)return;
  // Select the smallest sufficient set, reducing object-version races.
  const target = BigInt(suiSpendMist || 0) + BigInt(tx.getData().gasData.budget || 100_000_000);
  const selected=[];let total=0n;
  for(const coin of coins.slice(0,128)){ selected.push(coin); total += BigInt(coin.balance); if(total >= target)break; }
  tx.setGasPayment(selected.map(c=>({objectId:c.coinObjectId,version:c.version,digest:c.digest})));
}
