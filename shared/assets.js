// Curated mainnet assets, not a market-cap ranking. Metadata is checked before execution.
export const MAINNET_ASSETS = Object.freeze([
  {
    "symbol": "SUI",
    "coinType": "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
    "decimals": 9,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "USDC",
    "coinType": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    "decimals": 6,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "DEEP",
    "coinType": "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
    "decimals": 6,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "WAL",
    "coinType": "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL",
    "decimals": 9,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "NS",
    "coinType": "0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS",
    "decimals": 6,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "IKA",
    "coinType": "0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA",
    "decimals": 9,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "SEND",
    "coinType": "0xb45fcfcc2cc07ce0702cc2d229621e046c906ef14d9b25e8e4d25f6e8763fef7::send::SEND",
    "decimals": 6,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "AUSD",
    "coinType": "0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD",
    "decimals": 6,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "USDSUI",
    "coinType": "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI",
    "decimals": 6,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "SUIUSDE",
    "coinType": "0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE",
    "decimals": 6,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "XBTC",
    "coinType": "0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC",
    "decimals": 8,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "USDT",
    "coinType": "0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT",
    "decimals": 6,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "WUSDC",
    "coinType": "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
    "decimals": 6,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "WUSDT",
    "coinType": "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN",
    "decimals": 6,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "WETH",
    "coinType": "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN",
    "decimals": 8,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "WBTC",
    "coinType": "0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN",
    "decimals": 8,
    "source": "Mysten DeepBook SDK mainnet coin registry"
  },
  {
    "symbol": "CETUS",
    "coinType": "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS",
    "decimals": 9,
    "source": "Existing verified on-chain metadata"
  },
  {
    "symbol": "NAVX",
    "coinType": "0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX",
    "decimals": 9,
    "source": "Existing verified on-chain metadata"
  }
]);
export const ASSET_BY_SYMBOL=Object.fromEntries(MAINNET_ASSETS.map(a=>[a.symbol,a]));
