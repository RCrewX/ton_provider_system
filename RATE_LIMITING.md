# Rate Limiting in Provider System

## Overview

The provider system implements **token bucket rate limiting** per provider to prevent 429 (rate limit) errors. Each provider has its own rate limiter configured with RPS (Requests Per Second) limits from `rpc.json`.

## How Rate Limiting Works

The rate limiter uses a token bucket algorithm:
- **Tokens refill** at the configured RPS rate (e.g., 10 RPS = 1 token every 100ms)
- **Burst size** allows some burst capacity (e.g., 15 tokens for 10 RPS)
- **Minimum delay** between requests is enforced (`minDelayMs = 1000 / RPS`)
- **Exponential backoff** on 429 errors (doubles delay, up to maxBackoffMs)

## The Problem: 429 Errors

When using `getTonClient()` and making direct TonClient API calls, **rate limiting is bypassed**. This can cause 429 (rate limit) errors.

## Root Cause

The provider system's rate limiter only works when:
1. Using `getEndpointWithRateLimit()` to acquire tokens before requests
2. Using adapter methods (`getAddressState()`, `runGetMethod()`, etc.) - **RECOMMENDED**
3. Manually calling `reportSuccess()` / `reportError()` after operations

**Direct TonClient calls bypass the rate limiter** because TonClient makes internal HTTP requests that we cannot intercept.

## RPS Configuration

The RPS (Requests Per Second) is configured correctly:
- **Chainstack**: 25 RPS → `minDelayMs = 40ms` (1000ms / 25)
- **TON Center**: 10 RPS → `minDelayMs = 100ms` (1000ms / 10)
- **Tatum**: 3 RPS → `minDelayMs = 334ms` (1000ms / 3)

The rate limiter uses a token bucket algorithm:
- Tokens refill at the configured RPS rate
- `minDelayMs` ensures minimum delay between requests
- Burst size allows some burst capacity

## Solutions

### Option 1: Use Adapter Methods (Recommended)

Instead of direct TonClient calls, use adapter methods that respect rate limiting:

```typescript
import { ProviderManager, NodeAdapter } from 'ton-provider-system';

const pm = ProviderManager.getInstance();
await pm.init('testnet');

const adapter = new NodeAdapter(pm);
const state = await adapter.getAddressState(address);
const balance = await adapter.getAddressBalance(address);
const result = await adapter.runGetMethod(address, 'method', []);
```

### Option 2: Use Rate Limit Wrapper

For operations that require TonClient directly, use the wrapper:

```typescript
import { ProviderManager, getTonClientWithRateLimit } from 'ton-provider-system';

const pm = ProviderManager.getInstance();
await pm.init('testnet');

const { client, withRateLimit } = await getTonClientWithRateLimit(pm);

// Wrap each operation
const balance = await withRateLimit(() => client.getBalance(address));
const state = await withRateLimit(() => client.getContractState(address));
const seqno = await withRateLimit(() => client.runMethod(address, 'seqno'));
```

### Option 3: Manual Rate Limit Management

Acquire tokens before operations and report results:

```typescript
import { ProviderManager, getTonClient } from 'ton-provider-system';

const pm = ProviderManager.getInstance();
await pm.init('testnet');
const client = await getTonClient(pm);

// Before each operation
await pm.getEndpointWithRateLimit();

try {
    const result = await client.someMethod();
    pm.reportSuccess(); // Report success
} catch (error) {
    pm.reportError(error); // Report error
    throw error;
}
```

## Usage Patterns

### Pattern 1: Adapter Methods (RECOMMENDED)

**Best for**: All use cases - automatically handles rate limiting

```typescript
import { ProviderManager, NodeAdapter } from 'ton-provider-system';

const pm = ProviderManager.getInstance();
await pm.init('testnet');

const adapter = new NodeAdapter(pm);

// All adapter methods automatically acquire rate limit tokens
const state = await adapter.getAddressState(address);
const balance = await adapter.getAddressBalance(address);
const result = await adapter.runGetMethod(address, 'method', []);
```

**Advantages**:
- ✅ Automatic rate limiting
- ✅ Automatic error reporting and failover
- ✅ Works in both Node.js and Browser
- ✅ No manual token management needed

### Pattern 2: getEndpointWithRateLimit() + TonClient

**Best for**: When you need TonClient directly (e.g., complex operations)

```typescript
import { ProviderManager, getTonClient } from 'ton-provider-system';

const pm = ProviderManager.getInstance();
await pm.init('testnet');
const client = await getTonClient(pm);

// Acquire rate limit token before each operation
const endpoint = await pm.getEndpointWithRateLimit(5000);

try {
    const result = await client.someMethod();
    pm.reportSuccess(); // Update rate limiter
} catch (error) {
    pm.reportError(error); // Trigger failover if needed
    throw error;
}
```

**Important**: You must call `getEndpointWithRateLimit()` before each operation, and report success/error.

### Pattern 3: Manual Token Management

**Best for**: Advanced use cases with custom request logic

```typescript
import { ProviderManager } from 'ton-provider-system';

const pm = ProviderManager.getInstance();
await pm.init('testnet');

// Get provider and acquire token manually
const provider = pm.getActiveProvider();
if (provider) {
    const rateLimiter = pm.getRateLimiter();
    const acquired = await rateLimiter?.acquire(provider.id, 5000);
    
    if (acquired) {
        try {
            // Make request
            const result = await makeRequest(provider.endpointV2);
            rateLimiter?.reportSuccess(provider.id);
        } catch (error) {
            rateLimiter?.reportError(provider.id);
            pm.reportError(error);
        }
    }
}
```

## Current Status

- ✅ RPS configuration is correct (from `rpc.json`)
- ✅ Rate limiter implementation is correct (token bucket algorithm)
- ✅ Adapter methods respect rate limiting automatically
- ✅ Health checks use rate limiting
- ⚠️ Direct TonClient usage bypasses rate limiting (use Pattern 2 or 3)
- ✅ Configurable cooldown period for retrying failed providers (default: 30s)

## Recommendation

**For all use cases**: Use **Pattern 1 (Adapter Methods)** - it's the simplest and most reliable.

**For deployment scripts and batch operations**:
1. ✅ Use adapter methods (Pattern 1) - **RECOMMENDED**
2. Or use `getEndpointWithRateLimit()` before each TonClient call (Pattern 2)
3. Or implement manual token management (Pattern 3)

The 429 errors occur when deployment scripts make rapid TonClient calls without rate limiting. The solution is to use one of the patterns above.
