# noise - COMPREHENSIVE IMPLEMENTATION PLAN

## 1. CURRENT PROJECT AUDIT

### Existing Infrastructure
- **Frontend**: Pure HTML/CSS/JS prototype in single file
- **Backend**: None
- **Database**: None
- **Wallet Integration**: None
- **Protocol Integrations**: None
- **API Connections**: None
- **Authentication**: None
- **Environment**: Local development only

### Existing Functionality
- ✅ Premium UI design system (Space Grotesk + Inter, dark theme)
- ✅ Responsive layout (desktop/tablet/mobile)
- ✅ Client-side navigation between pages
- ✅ Visual components for all major sections
- ✅ Mock data display
- ✅ GSAP animations
- ✅ Basic interactions

### Mocked Functionality (Needs Real Implementation)
- ❌ Portfolio balances and positions
- ❌ Token discovery data
- ❌ APY/yield opportunities
- ❌ Swap quotes and execution
- ❌ Earn deposit/withdraw flows
- ❌ Staking operations
- ❌ Lending protocols
- ❌ Liquidity management
- ❌ Activity timeline
- ❌ Automation rules and execution
- ❌ AI assistant tools
- ❌ Fee calculation
- ❌ Referral system

### Technical Debt
- Single HTML file needs to be split into proper project structure
- No framework chosen (needs decision)
- No build system
- No environment configuration
- No API keys or credentials
- No error handling
- No loading states
- No real-time updates

---

## 2. MISSING FUNCTIONALITY ANALYSIS

### Critical Path Components
1. **Wallet Connection** - Required for all user actions
2. **Balance/Position Aggregation** - Core Capital functionality
3. **Protocol Adapter System** - Foundation for all integrations
4. **Transaction Building & Signing** - Execution layer
5. **Fee Engine** - Revenue model
6. **Basic Swap Integration** - First real protocol action

### Secondary Components
7. **Earn Deposit/Withdraw** - Yield functionality
8. **Staking Integration** - Native Sui staking
9. **Lending Integration** - DeFi lending protocols
10. **Automation Engine** - Scheduled actions
11. **AI Integration** - Natural language interface
12. **Referral System** - Revenue sharing

### Nice-to-Have
13. **Liquidity Management** - LP positions
14. **NFT Integration** - NFT marketplace
15. **Bridge Integration** - Cross-chain transfers
16. **DeepBook Trading** - Order book trading
17. **Advanced Analytics** - Portfolio insights

---

## 3. SUI ECOSYSTEM RESEARCH MATRIX

### Trading/Swap Protocols
| Protocol | Status | Official API | SDK | Notes |
|----------|--------|--------------|-----|-------|
| Cetus | RESEARCH NEEDED | TBD | TBD | Primary DEX on Sui |
| Aftermath | RESEARCH NEEDED | TBD | TBD | DEX + aggregator |
| DeepBook | RESEARCH NEEDED | TBD | TBD | Order book exchange |
| Turbos | RESEARCH NEEDED | TBD | TBD | DEX |
| Kriya | RESEARCH NEEDED | TBD | TBD | DEX |

### Lending Protocols
| Protocol | Status | Official API | SDK | Notes |
|----------|--------|--------------|-----|-------|
| NAVI | RESEARCH NEEDED | TBD | TBD | Leading lending protocol |
| Suilend | RESEARCH NEEDED | TBD | TBD | Aave-inspired lending |
| Scallop | RESEARCH NEEDED | TBD | TBD | Lending protocol |
| Bucket | RESEARCH NEEDED | TBD | TBD | Lending protocol |

### Staking/Liquid Staking
| Protocol | Status | Official API | SDK | Notes |
|----------|--------|--------------|-----|-------|
| Native Sui | RESEARCH NEEDED | TBD | TBD | Native blockchain staking |
| Aftermath | RESEARCH NEEDED | TBD | TBD | Liquid staking |
| Haedal | RESEARCH NEEDED | TBD | TBD | Liquid staking |
| Volo | RESEARCH NEEDED | TBD | TBD | Liquid staking |

### Data/Indexing Services
| Service | Status | API Type | Notes |
|---------|--------|----------|-------|
| Sui RPC | RESEARCH NEEDED | RPC | Blockchain data |
| Sui Indexer | RESEARCH NEEDED | REST/API | Enhanced blockchain data |
| Third-party indexers | RESEARCH NEEDED | Various | Additional data sources |

---

## 4. RECOMMENDED TECHNICAL STACK

### Frontend Framework
**Recommendation**: Next.js 14+ with TypeScript
- Server-side rendering for performance
- API routes for backend
- Built-in routing
- TypeScript for type safety
- Strong ecosystem

### Backend
**Recommendation**: Node.js + TypeScript
- Same language as frontend
- Rich ecosystem
- Easy protocol integration

### Database
**Recommendation**: PostgreSQL
- Relational data for financial accuracy
- ACID compliance for transactions
- Strong typing
- Proven scalability

### Blockchain Interaction
**Recommendation**: 
- `@mysten/sui.js` for Sui SDK
- `@mysten/dapp-kit` for wallet connection
- TypeScript Move packages for type safety

### State Management
**Recommendation**: React Query + Zustand
- React Query for server state
- Zustand for client state
- Optimistic updates

### Real-time
**Recommendation**: WebSocket + Server-Sent Events
- For live price updates
- Transaction status tracking
- Automation triggers

---

## 5. BACKEND ARCHITECTURE

```
┌─────────────────────────────────────────────────────────┐
│                     NEXT.JS FRONTEND                    │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    API LAYER (Next.js API Routes)        │
│  /api/wallet, /api/capital, /api/swap, /api/earn...   │
└─────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   SERVICES  │  │   ADAPTERS   │  │   ENGINES   │
├──────────────┤  ├──────────────┤  ├──────────────┤
│ Wallet Svc  │  │ CetusAdapter  │  │  Fee Engine  │
│ Capital Svc │  │ NaviAdapter   │  │ Referral Eng │
│ Earn Svc    │  │ SuilendAdapter│  │ Automation  │
│ Swap Svc    │  │ SuiStakeAdapter│  │   Engine     │
│ Activity Svc│  │ DeepBookAdapter│  │              │
└──────────────┘  └──────────────┘  └──────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                  PROTOCOL APIs / SDKs                   │
│  Cetus, NAVI, Suilend, Sui RPC, Indexers, etc.       │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                    POSTGRESQL DATABASE                  │
│  Users, Wallets, Positions, Transactions, Fees, etc.   │
└─────────────────────────────────────────────────────────┘
```

---

## 6. DATA MODELS

### Core Models
```typescript
// User
interface User {
  id: string;
  walletAddress: string;
  referralCode: string;
  referredBy?: string;
  createdAt: Date;
}

// Wallet
interface Wallet {
  address: string;
  connectedAt: Date;
  lastActivity: Date;
}

// Balance
interface Balance {
  token: string;
  symbol: string;
  amount: string;
  decimals: number;
  source: 'wallet' | 'protocol';
  protocolId?: string;
}

// Position
interface Position {
  id: string;
  type: 'staking' | 'lending' | 'liquidity' | 'earn';
  protocol: string;
  asset: string;
  amount: string;
  valueUsd: string;
  apy?: number;
  rewards?: string;
  status: 'active' | 'inactive';
}

// Token
interface Token {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price?: string;
  liquidity?: string;
  volume?: string;
  change24h?: string;
}

// Protocol
interface Protocol {
  id: string;
  name: string;
  category: 'dex' | 'lending' | 'staking' | 'yield';
  status: 'LIVE_EXECUTION' | 'READ_ONLY' | 'DISCOVERY_ONLY';
  website: string;
  docs: string;
  feeModel: string;
  lastVerified: Date;
}

// Transaction
interface Transaction {
  id: string;
  userId: string;
  type: 'swap' | 'deposit' | 'withdraw' | 'stake' | 'unstake';
  protocol: string;
  fromAsset?: string;
  toAsset?: string;
  amount: string;
  fees: FeeBreakdown;
  status: 'pending' | 'confirmed' | 'failed';
  txDigest?: string;
  timestamp: Date;
}

// Fee
interface FeeBreakdown {
  protocolFee: string;
  providerFee: string;
  platformFee: string;
  networkFee: string;
  total: string;
}

// Automation
interface Automation {
  id: string;
  userId: string;
  trigger: AutomationTrigger;
  action: AutomationAction;
  limits: AutomationLimits;
  status: 'active' | 'paused' | 'revoked';
  createdAt: Date;
}

// Referral
interface Referral {
  id: string;
  referrerId: string;
  referredId: string;
  revenueGenerated: string;
  rewardPaid: string;
  createdAt: Date;
}
```

---

## 7. PROTOCOL ADAPTER ARCHITECTURE

### Base Interface
```typescript
interface ProtocolAdapter {
  id: string;
  name: string;
  category: 'dex' | 'lending' | 'staking' | 'yield';
  
  // Metadata
  getMetadata(): Promise<ProtocolMetadata>;
  
  // Data
  getBalances(wallet: string): Promise<Balance[]>;
  getPositions(wallet: string): Promise<Position[]>;
  getPools(): Promise<Pool[]>;
  getTokens(): Promise<Token[]>;
  
  // Quotes
  getSwapQuote(request: SwapRequest): Promise<SwapQuote>;
  getEarnQuote(request: EarnRequest): Promise<EarnQuote>;
  
  // Execution
  buildSwapTransaction(request: SwapRequest): Promise<TransactionPlan>;
  buildEarnTransaction(request: EarnRequest): Promise<TransactionPlan>;
  
  // Simulation
  simulateTransaction(plan: TransactionPlan): Promise<SimulationResult>;
  
  // Status
  getTransactionStatus(txDigest: string): Promise<TransactionStatus>;
}
```

### Adapter Registry
```typescript
class ProtocolRegistry {
  private adapters: Map<string, ProtocolAdapter> = new Map();
  
  register(adapter: ProtocolAdapter): void;
  get(id: string): ProtocolAdapter;
  getByCategory(category: string): ProtocolAdapter[];
  getCapable(action: string): ProtocolAdapter[];
}
```

---

## 8. CAPITAL ARCHITECTURE

### Data Flow
```
Wallet Connection
    ↓
Fetch Wallet Balances (Sui RPC)
    ↓
Fetch Protocol Positions (Adapters)
    ↓
Fetch Staking Positions (Adapters)
    ↓
Fetch LP Positions (Adapters)
    ↓
Fetch Rewards (Adapters)
    ↓
Normalize & Deduplicate
    ↓
Calculate Portfolio Value
    ↓
Return Unified Capital View
```

### No Double Counting Logic
```typescript
class CapitalAggregator {
  async getCapital(wallet: string): Promise<CapitalView> {
    const [walletBalances, protocolPositions] = await Promise.all([
      this.getWalletBalances(wallet),
      this.getProtocolPositions(wallet)
    ]);
    
    // Deduplicate: don't count deposited tokens as wallet balance
    const normalized = this.normalizePositions(walletBalances, protocolPositions);
    
    return {
      totalValue: this.calculateTotalValue(normalized),
      available: this.calculateAvailable(normalized),
      staked: this.calculateStaked(normalized),
      invested: this.calculateInvested(normalized),
      rewards: this.calculateRewards(normalized),
      borrowed: this.calculateBorrowed(normalized)
    };
  }
}
```

---

## 9. SWAP ARCHITECTURE

### Quote Aggregation
```typescript
class SwapAggregator {
  async getBestQuote(request: SwapRequest): Promise<SwapQuote> {
    const adapters = this.registry.getCapable('swap');
    const quotes = await Promise.all(
      adapters.map(adapter => adapter.getSwapQuote(request))
    );
    
    // Find best route by output amount
    const best = quotes.reduce((a, b) => 
      parseFloat(b.outputAmount) > parseFloat(a.outputAmount) ? b : a
    );
    
    return {
      ...best,
      provider: best.protocol,
      route: best.route,
      fees: this.calculateFees(best)
    };
  }
}
```

### Transaction Flow
```
User Input
    ↓
Get Quotes from all providers
    ↓
Select best route
    ↓
Calculate fees (protocol + provider + platform + network)
    ↓
Build transaction via adapter
    ↓
Simulate transaction
    ↓
Show user: provider, route, fees, risks, expected output
    ↓
User confirms
    ↓
Wallet signs transaction
    ↓
Submit to blockchain
    ↓
Track status
    ↓
Record in Activity
    ↓
Update Capital
```

---

## 10. EARN ARCHITECTURE

### Deposit Flow
```
User selects opportunity
    ↓
Fetch live APY, TVL, conditions from protocol
    ↓
Calculate estimated earnings
    ↓
Show fees, withdrawal conditions, risks
    ↓
Mandatory custody disclosure
    ↓
User confirms
    ↓
Build deposit transaction via adapter
    ↓
Simulate
    ↓
Wallet signs
    ↓
Execute
    ↓
Record position in Capital
    ↓
Update Activity
```

### APY Calculation
```typescript
class YieldCalculator {
  calculateAnnualYield(principal: number, apy: number): number {
    return principal * (apy / 100);
  }
  
  calculatePeriodYield(principal: number, apy: number, days: number): number {
    return principal * (apy / 100) * (days / 365);
  }
  
  // Store source and timestamp
  calculateWithMetadata(principal: number, apy: number, source: string) {
    return {
      annualYield: this.calculateAnnualYield(principal, apy),
      apy,
      apySource: source,
      apyTimestamp: new Date()
    };
  }
}
```

---

## 11. AUTOMATION ARCHITECTURE

### System Design
```
User creates automation (natural language or UI)
    ↓
AI converts to structured intent (if NL)
    ↓
Intent validation
    ↓
Permission check
    ↓
Store in database
    ↓
Scheduler / Event Listener
    ↓
Trigger evaluation
    ↓
If conditions met:
    ↓
Permission check
    ↓
Build action via adapter
    ↓
Simulate
    ↓
If execution allowed:
    ↓
Request wallet signature
    ↓
Execute
    ↓
Record in Activity
    ↓
Update Capital
```

### Permission Model
```typescript
interface AutomationPermissions {
  default: 'read' | 'notify';
  execution: {
    maxPerExecutionUsd: number;
    maxDailyUsd: number;
    allowedActions: string[];
    expiresAt: Date;
  };
}
```

---

## 12. AI ARCHITECTURE

### Tool System
```typescript
const aiTools = {
  getPortfolio: async () => capitalService.getPortfolio(wallet),
  getBalances: async () => capitalService.getBalances(wallet),
  getEarnOpportunities: async () => earnService.getOpportunities(wallet),
  getLendingMarkets: async () => lendingService.getMarkets(),
  getStakingOptions: async () => stakingService.getOptions(wallet),
  getLiquidityPositions: async () => liquidityService.getPositions(wallet),
  getTokenData: async (token) => tokenService.getData(token),
  getProtocolDetails: async (protocol) => protocolService.getDetails(protocol),
  getActivity: async () => activityService.getHistory(wallet),
  compareEarn: async (asset) => earnService.compare(asset),
  buildAction: async (intent) => actionService.build(intent),
  simulateAction: async (action) => simulationService.simulate(action)
};
```

### Security Model
```typescript
class AISecurityGuard {
  validateToolCall(tool: string, params: any): boolean {
    // Block dangerous operations
    const blocked = ['signTransaction', 'exportKeys', 'bypassPermissions'];
    if (blocked.includes(tool)) return false;
    
    // Validate parameters
    return this.validateParams(params);
  }
  
  sanitizeOutput(output: any): any {
    // Remove sensitive data
    // Validate no hallucinated protocols
    // Ensure source attribution
  }
}
```

---

## 13. FEE ENGINE ARCHITECTURE

### Fee Calculation
```typescript
class FeeEngine {
  calculateSwapFees(amount: string, config: FeeConfig): FeeBreakdown {
    const amountNum = parseFloat(amount);
    
    return {
      protocolFee: this.calculateProtocolFee(amountNum, config),
      providerFee: this.calculateProviderFee(amountNum, config),
      platformFee: this.calculatePlatformFee(amountNum, config),
      networkFee: config.networkFee,
      total: this.calculateTotal(amountNum, config)
    };
  }
  
  private calculatePlatformFee(amount: number, config: FeeConfig): string {
    const fee = amount * (config.platformFeeBps / 10000);
    return this.toFixed(fee, 6);
  }
}
```

### Configuration
```typescript
interface FeeConfig {
  swap: {
    platformFeeBps: number; // e.g., 20 = 0.20%
    networkFee: string;
  };
  earn: {
    platformFeeBps: number;
    networkFee: string;
  };
  // ... other action types
}
```

---

## 14. REFERRAL ENGINE ARCHITECTURE

### Attribution Logic
```typescript
class ReferralEngine {
  async trackAttribution(userId: string, referralCode: string): Promise<void> {
    const referrer = await this.getReferrer(referralCode);
    
    // Prevent self-referral
    if (referrer.userId === userId) {
      throw new Error('Self-referral not allowed');
    }
    
    // Store attribution with expiration window
    await this.createAttribution(userId, referrer.userId);
  }
  
  async calculateReward(transaction: Transaction): Promise<string> {
    const eligibleRevenue = this.getEligibleRevenue(transaction);
    const referralRate = this.config.referralRate; // e.g., 30%
    
    const reward = eligibleRevenue * (referralRate / 100);
    return this.toFixed(reward, 6);
  }
}
```

### Revenue Ledger
```typescript
interface RevenueEntry {
  transactionId: string;
  userId: string;
  provider: string;
  action: string;
  protocolFee: string;
  platformFee: string;
  providerRevenueShare: string;
  referralReward: string;
  netPlatformRevenue: string;
  timestamp: Date;
}
```

---

## 15. SECURITY MODEL

### Non-Custodial Principles
```typescript
class SecurityGuard {
  // Never store private keys
  validateNoKeyStorage(): boolean;
  
  // Always require wallet signature
  requireWalletSignature(transaction: Transaction): boolean;
  
  // Never bypass permission checks
  validatePermissions(action: Action, user: User): boolean;
  
  // Transaction simulation before execution
  async simulateBeforeExecute(transaction: Transaction): Promise<boolean>;
  
  // Input validation
  validateInput(input: any): boolean;
  
  // Rate limiting
  checkRateLimit(userId: string): boolean;
}
```

### Automation Safety
```typescript
class AutomationSafety {
  // Default to read-only
  defaultMode: 'read' | 'notify' = 'notify';
  
  // Execution requires explicit permission
  requireExecutionPermission(automation: Automation): boolean;
  
  // Limits per execution
  validatePerExecutionLimits(automation: Automation, action: Action): boolean;
  
  // Daily limits
  validateDailyLimits(automation: Automation): boolean;
  
  // Audit trail
  async logExecution(automation: Automation, action: Action): Promise<void>;
}
```

---

## 16. API STRUCTURE

### Next.js API Routes
```
/api/auth
  POST /connect-wallet
  POST /disconnect

/api/capital
  GET /portfolio
  GET /balances
  GET /positions

/api/discover
  GET /tokens
  GET /pools
  GET /protocols
  GET /opportunities

/api/earn
  GET /opportunities
  GET /quote
  POST /deposit
  POST /withdraw

/api/actions
  GET /quote (swap)
  POST /build-transaction
  POST /simulate
  POST /execute

/api/automation
  GET /list
  POST /create
  POST /pause
  POST /revoke
  GET /history

/api/activity
  GET /history
  GET /transaction/:id

/api/ai
  POST /chat

/api/referral
  GET /my-code
  GET /stats
```

---

## 17. ENVIRONMENT & API KEYS REQUIRED

### Required for Development
- **Sui RPC Endpoint**: Mainnet RPC URL
- **Sui Testnet RPC**: Testnet RPC URL
- **Database**: PostgreSQL connection string
- **AI Provider API Key**: OpenAI/Anthropic/other
- **Protocol APIs**: Cetus, NAVI, etc. (as researched)

### Environment Variables
```env
# Database
DATABASE_URL=

# Sui Blockchain
SUI_RPC_URL=
SUI_TESTNET_RPC_URL=

# AI Provider
OPENAI_API_KEY=
# or
ANTHROPIC_API_KEY=

# Protocol APIs (as researched)
CETUS_API_KEY=
NAVI_API_KEY=
SUILEND_API_KEY=

# App Configuration
NEXT_PUBLIC_APP_URL=
PLATFORM_FEE_CONFIG=
REFERRAL_RATE=

# Security
JWT_SECRET=
ENCRYPTION_KEY=
```

---

## 18. IMPLEMENTATION ORDER

### Phase 1: Foundation (Week 1-2)
1. Set up Next.js + TypeScript project
2. Configure PostgreSQL database
3. Implement basic project structure
4. Set up environment configuration
5. Create base data models
6. Implement basic authentication (wallet connection)

### Phase 2: Protocol Research (Week 2-3)
1. Research Cetus API/SDK
2. Research NAVI API/SDK
3. Research Sui RPC capabilities
4. Research Sui staking
5. Create protocol registry
6. Document integration capabilities

### Phase 3: Adapter System (Week 3-4)
1. Implement base adapter interface
2. Create Cetus adapter (swap)
3. Create NAVI adapter (lending)
4. Create Sui staking adapter
5. Implement adapter registry
6. Test protocol connections

### Phase 4: Capital (Week 4-5)
1. Implement wallet balance fetching
2. Implement position aggregation
3. Implement no-double-counting logic
4. Implement portfolio value calculation
5. Connect to frontend Capital page
6. Add real-time updates

### Phase 5: Swap (Week 5-6)
1. Implement quote aggregation
2. Implement transaction building
3. Implement simulation
4. Implement wallet signing
5. Implement fee calculation
6. Connect to Actions page
7. Add provider attribution

### Phase 6: Earn (Week 6-7)
1. Implement opportunity fetching
2. Implement deposit flow
3. Implement withdrawal flow
4. Add custody disclosures
5. Implement APY calculations
6. Connect to Earn page
7. Add real protocol data

### Phase 7: Staking/Lending (Week 7-8)
1. Implement staking adapters
2. Implement lending adapters
3. Add to Actions page
4. Implement position tracking
5. Add to Capital aggregation

### Phase 8: Discover (Week 8-9)
1. Implement token discovery
2. Implement pool discovery
3. Implement protocol discovery
4. Add real ecosystem data
5. Connect to Discover page
6. Add data freshness indicators

### Phase 9: Activity (Week 9)
1. Implement transaction tracking
2. Implement status monitoring
3. Implement unified history
4. Connect to Activity page
5. Add filtering

### Phase 10: Automation (Week 10-11)
1. Implement trigger system
2. Implement scheduler
3. Implement permission engine
4. Implement execution engine
5. Add safety limits
6. Connect to Automation page
7. Add audit logging

### Phase 11: AI (Week 11-12)
1. Implement tool system
2. Implement AI security guard
3. Connect to AI provider
4. Implement tool routing
5. Add to AI page
6. Test with real data

### Phase 12: Fee Engine (Week 12)
1. Implement fee calculation
2. Implement fee display
3. Add to transaction flows
4. Configure platform fees

### Phase 13: Referral (Week 12-13)
1. Implement referral tracking
2. Implement attribution logic
3. Implement reward calculation
4. Implement revenue ledger
5. Add referral dashboard
6. Add anti-abuse measures

### Phase 14: Testing & Polish (Week 13-14)
1. End-to-end testing
2. Security audit
3. Performance optimization
4. Error handling
5. Loading states
6. User testing
7. Documentation

---

## 19. RISKS & BLOCKERS

### Technical Risks
- **Protocol API Changes**: APIs may change without notice
- **Rate Limiting**: Protocol APIs may have strict limits
- **Simulation Accuracy**: Simulation may not predict actual execution
- **Transaction Failures**: Blockchain transactions may fail
- **Wallet Compatibility**: Different wallets may have issues

### Business Risks
- **Protocol Insolvency**: Underlying protocols may fail
- **Smart Contract Risk**: Protocol contracts may have vulnerabilities
- **Market Volatility**: APY/yield may change dramatically
- **Regulatory Risk**: DeFi regulations may change

### Mitigation Strategies
- Regular protocol research and updates
- Multiple provider redundancy
- Clear risk disclosures
- Conservative fee structure
- Regular security audits
- User education

---

## 20. TESTING STRATEGY

### Unit Tests
- Protocol adapter methods
- Fee calculations
- Referral logic
- Data transformations
- Permission checks

### Integration Tests
- Protocol API connections
- Wallet signing flows
- Transaction building
- Database operations

### End-to-End Tests
- Complete swap flow
- Complete earn flow
- Complete staking flow
- Automation execution
- AI tool calls

### Security Tests
- Permission bypass attempts
- SQL injection
- XSS attacks
- API abuse
- Rate limiting

---

## 21. NEXT STEPS

This implementation plan provides a complete roadmap for transforming the UI prototype into a production-ready Sui Action Hub. 

**Immediate Next Actions:**
1. Review and approve this implementation plan
2. Choose technical stack (confirm Next.js + TypeScript + PostgreSQL)
3. Begin Phase 1: Foundation setup
4. Start Phase 2: Protocol research (focus on Cetus first for swap)
5. Implement protocol adapter system foundation

**Critical Dependencies:**
- Access to Sui mainnet/testnet RPC
- AI provider API key
- Database hosting
- Protocol API access (as researched)

The plan prioritizes getting the first real integration (swap via Cetus) working before expanding to other protocols, ensuring the adapter system and execution layer are solid before scaling complexity.
