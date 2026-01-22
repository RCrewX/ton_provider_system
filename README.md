# Unified TON Provider System

A bullet-proof TON RPC provider management system for multi-project use.

## Features

- **Multi-provider support** with automatic failover
- **Health checking** with latency and block height monitoring
- **Token bucket rate limiting** per provider
- **Automatic best provider selection** based on health, latency, and priority
- **Custom endpoint override** for testing
- **Environment-based configuration** via `.env` file
- **Cross-platform** - works in Node.js and Browser environments

## Installation

### NPM Package

```bash
# Using npm
npm install ton-provider-system

# Using pnpm
pnpm add ton-provider-system

# Using yarn
yarn add ton-provider-system
```

### Peer Dependencies

This package requires the following peer dependencies (you must install them in your project):

```bash
pnpm add @ton/core @ton/ton @orbs-network/ton-access
```

Or add to your `package.json`:

```json
{
  "dependencies": {
    "ton-provider-system": "^0.1.0",
    "@orbs-network/ton-access": "^2.3.0",
    "@ton/core": "^0.59.0",
    "@ton/ton": "^15.0.0"
  }
}
```

## Quick Start

### Node.js (Scripts, Telegram Bot)

```typescript
import { ProviderManager, getTonClient } from 'ton-provider-system';

// Initialize
const pm = ProviderManager.getInstance();
await pm.init('testnet');

// Get TonClient for blockchain operations
const client = await getTonClient(pm);

// Use the client
const balance = await client.getBalance(address);
```

### Browser (React/Next.js)

```typescript
import { ProviderManager, BrowserAdapter } from 'ton-provider-system';

// Create instance (not singleton for React)
const pm = new ProviderManager({ adapter: 'browser' });
await pm.init(network);

// Use browser adapter for fetch-based operations
const adapter = new BrowserAdapter(pm);
const balance = await adapter.getAddressBalance(address);
```

## Configuration

### Provider Definitions

The package includes default provider definitions in `rpc.json` (bundled with the package).
This file contains:
- Provider endpoints with `{key}` placeholders
- Environment variable names for API keys
- RPS limits and priorities
- Default provider order per network

The JSON Schema (`rpc-schema.json`) provides validation and IDE autocomplete.

**Note**: The default `rpc.json` is included in the package. You can override it by providing a custom path when creating the registry.

### Environment Variables

Set API keys in your `.env` file. See `env.example` for a complete template.

```bash
# TON Center (10 RPS with API key, 1 RPS without)
TONCENTER_API_KEY=your-toncenter-api-key

# Chainstack (25 RPS) - extract key from URL
# URL: https://ton-testnet.core.chainstack.com/YOUR_KEY/api/v2
CHAINSTACK_KEY_TESTNET=your-chainstack-key

# QuickNode (15 RPS) - use subdomain from URL
QUICKNODE_KEY_MAINNET=your-quicknode-subdomain

# GetBlock (20 RPS) - use the access token
GETBLOCK_KEY_MAINNET=your-getblock-token

# OnFinality (4 RPS) - use apikey from URL
ONFINALITY_KEY_TESTNET=your-onfinality-apikey

# Tatum (3 RPS) - separate keys for testnet/mainnet
TATUM_API_KEY_TESTNET=your-tatum-testnet-key
TATUM_API_KEY_MAINNET=your-tatum-mainnet-key
```

The `{key}` placeholder in endpoint URLs is replaced with the env var value.

## API Reference

### ProviderManager

Main entry point for the provider system.

```typescript
// Singleton (recommended for Node.js)
const pm = ProviderManager.getInstance();

// Instance (recommended for Browser/React)
const pm = new ProviderManager({ adapter: 'browser' });

// Initialize for a network
await pm.init('testnet');
await pm.init('mainnet');

// Get endpoint URL
const endpoint = await pm.getEndpoint();

// Get endpoint with rate limiting
const endpoint = await pm.getEndpointWithRateLimit(5000);

// Test all providers
const results = await pm.testAllProviders();

// Report errors (for automatic failover)
pm.reportError(error);
pm.reportSuccess();

// Manual provider selection
pm.setSelectedProvider('chainstack_testnet');
pm.setAutoSelect(true);

// Custom endpoint override
pm.setCustomEndpoint('https://custom.endpoint/api/v2');
```

### NodeAdapter

Node.js adapter with TonClient and REST API support.

```typescript
import { NodeAdapter, getTonClient } from './provider_system';

const adapter = new NodeAdapter(pm);

// Get TonClient
const client = await adapter.getClient();

// REST API methods
const state = await adapter.getAddressState(address);
const balance = await adapter.getAddressBalance(address);
const result = await adapter.runGetMethod(address, 'get_data', []);
await adapter.sendBoc(boc);
const deployed = await adapter.isContractDeployed(address);
```

### BrowserAdapter

Browser-compatible adapter using fetch.

```typescript
import { BrowserAdapter } from './provider_system';

const adapter = new BrowserAdapter(pm);

// REST API methods
const state = await adapter.getAddressState(address);
const balance = await adapter.getAddressBalance(address);
const info = await adapter.getAddressInfo(address);
const result = await adapter.runGetMethod(address, 'get_data', []);

// JSON-RPC method
const data = await adapter.jsonRpc('getMasterchainInfo');
```

### HealthChecker

Test provider health and connectivity.

```typescript
import { createHealthChecker, createRegistry } from './provider_system';

const registry = await createRegistry();
const healthChecker = createHealthChecker({
  timeoutMs: 10000,
  maxBlocksBehind: 10,
});

// Test single provider
const result = await healthChecker.testProvider(provider);

// Test multiple providers
const results = await healthChecker.testProviders(providers);

// Get best provider
const best = healthChecker.getBestProvider('testnet');
```

### RateLimiterManager

Per-provider rate limiting with token bucket algorithm.

```typescript
import { createRateLimiterManager } from './provider_system';

const rateLimiter = createRateLimiterManager();

// Configure for a provider
rateLimiter.setConfig('chainstack_testnet', {
  rps: 25,
  burstSize: 30,
  minDelayMs: 40,
  backoffMultiplier: 2,
  maxBackoffMs: 10000,
});

// Acquire token before making request
const acquired = await rateLimiter.acquire('chainstack_testnet', 5000);
if (acquired) {
  // Make request
  rateLimiter.reportSuccess('chainstack_testnet');
} else {
  // Rate limit timeout
}

// Report rate limit error
rateLimiter.reportRateLimitError('chainstack_testnet');
```

## File Structure

```
provider_system/
├── rpc.json              # Provider definitions (main config)
├── rpc-schema.json       # JSON Schema for validation
├── README.md             # This file
├── index.ts              # Main exports
├── types.ts              # TypeScript interfaces
├── config/
│   ├── schema.ts         # Zod schema validation
│   ├── parser.ts         # Config loading and env resolution
│   └── index.ts          # Config exports
├── core/
│   ├── registry.ts       # Provider registry
│   ├── healthChecker.ts  # Health/latency checks
│   ├── rateLimiter.ts    # Token bucket rate limiter
│   ├── selector.ts       # Best provider selection
│   ├── manager.ts        # Main ProviderManager
│   └── index.ts          # Core exports
├── adapters/
│   ├── node.ts           # Node.js adapter (TonClient)
│   ├── browser.ts        # Browser adapter (fetch)
│   └── index.ts          # Adapter exports
├── utils/
│   ├── endpoint.ts       # URL normalization
│   ├── timeout.ts        # Timeout utilities
│   └── index.ts          # Utils exports
└── test.ts               # Test script
```

## Integration Guide

### Node.js Project

1. Install the package:

```bash
pnpm add ton-provider-system @ton/core @ton/ton @orbs-network/ton-access
```

2. Use in your code:

```typescript
import { ProviderManager, getTonClient } from 'ton-provider-system';

const pm = ProviderManager.getInstance();
await pm.init('testnet');
const client = await getTonClient(pm);
```

### Next.js/React (Browser)

1. Install the package:

```bash
pnpm add ton-provider-system @ton/core @orbs-network/ton-access
```

2. Use in your React component:

```typescript
import { ProviderManager, BrowserAdapter } from 'ton-provider-system';

export function ProviderProvider({ children }) {
  const { network } = useNetwork();
  const [manager] = useState(() => new ProviderManager({ adapter: 'browser' }));
  const [adapter, setAdapter] = useState<BrowserAdapter | null>(null);

  useEffect(() => {
    manager.init(network).then(() => {
      setAdapter(new BrowserAdapter(manager));
    });
  }, [network, manager]);

  // ...
}
```

### Telegram Bot

1. Install the package:

```bash
pnpm add ton-provider-system @ton/core @ton/ton @orbs-network/ton-access
```

2. Initialize on bot startup:

```typescript
// src/bot.ts
import { ProviderManager } from 'ton-provider-system';

const pm = ProviderManager.getInstance();

async function startBot() {
  // Initialize provider system
  await pm.init(getNetwork());
  
  // Optionally re-test providers periodically
  setInterval(() => {
    pm.testAllProviders().catch(console.error);
  }, 5 * 60 * 1000); // Every 5 minutes
  
  // Start bot
  bot.start();
}
```

## Development

### Building

```bash
# Build the library
pnpm build

# Watch mode for development
pnpm dev
```

### Testing

```bash
# Run full test suite
pnpm test

# Quick test (skip network tests)
pnpm test:quick

# Verbose test output
pnpm test:verbose
```

**Note**: Tests require environment variables to be set in `.env` file. See `env.example` for template.

## Troubleshooting

### No providers available

1. Check `.env` file has API keys configured
2. Run `pnpm check-connection` to test providers

### Rate limit errors

1. The system automatically switches to next provider on 429 errors
2. Configure more providers in `.env` for redundancy

### Block height mismatch (stale provider)

1. Provider is returning old data
2. System marks it as `stale` and prefers fresh providers

## Publishing

This package is published to NPM. To publish a new version:

1. Update version in `package.json` (follow semver)
2. Run `pnpm build` to ensure latest code is built
3. Run `npm pack --dry-run` to verify what will be published
4. Publish: `npm publish --access public` (if scoped package)

## License

MIT
