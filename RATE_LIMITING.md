# Rate Limiting in Provider System

## The Problem: 429 Errors

When using `getTonClient()` and making direct TonClient API calls, **rate limiting is bypassed**. This can cause 429 (rate limit) errors.

## Root Cause

The provider system's rate limiter only works when:
1. Using `getEndpointWithRateLimit()` to acquire tokens
2. Using adapter methods (`getAddressState()`, `runGetMethod()`, etc.)
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

## Current Status

- ✅ RPS configuration is correct
- ✅ Rate limiter implementation is correct
- ⚠️ Direct TonClient usage bypasses rate limiting
- ✅ Adapter methods respect rate limiting
- ✅ New wrapper function available for TonClient operations

## Recommendation

For deployment scripts and batch operations:
1. Use `getTonClientWithRateLimit()` wrapper
2. Or use adapter methods instead of direct TonClient calls
3. Or add manual rate limit token acquisition before operations

The 429 errors are happening because the deployment script makes rapid TonClient calls without rate limiting. The solution is to use one of the approaches above.
