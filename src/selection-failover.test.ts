#!/usr/bin/env tsx
/**
 * OFFLINE regression test — testnet getTransactions provider selection / failover.
 *
 * Context (bug): on testnet the consumer (uap `catch_up`) reads account
 * transactions through this library's selected endpoint. Orbs was selected
 * FIRST (better/lower priority than Toncenter) but Orbs only proxies liteserver
 * get-methods — its v2 `getTransactions` 403s — so every transactions read
 * dead-lettered with no recovery. The fix makes a transactions-capable provider
 * (Toncenter testnet) win selection on testnet, with Orbs demoted to fallback.
 *
 * Why this test is OFFLINE: selection is purely score-based over the providers'
 * config (priority) + their health results. We seed health results directly
 * (no network) and assert which provider the selector picks. This proves the
 * selection/failover behaviour deterministically — the live `tsx src/test.ts`
 * harness needs outbound network (provider HTTP) which the build sandbox blocks.
 *
 * Run:  pnpm -C <repo> exec tsx src/selection-failover.test.ts
 *       (or)  npx tsx src/selection-failover.test.ts
 *
 * Exits non-zero on any failed assertion.
 */

import {
    createDefaultConfig,
    ProviderRegistry,
    createSelector,
    HealthChecker,
    type Network,
    type ProviderHealthResult,
    type Logger,
} from './index';

// ---------------------------------------------------------------------------
// Tiny offline harness
// ---------------------------------------------------------------------------

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
        console.log(`  ✓ ${name}`);
    } else {
        failures++;
        console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// Silence the selector's internal logging so the test output stays readable.
const silentLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

/** Build a healthy (available, success:true) result for a provider. */
function healthy(
    id: string,
    network: Network,
    latencyMs: number,
    seqno = 1_000,
): ProviderHealthResult {
    return {
        id,
        network,
        success: true,
        status: 'available',
        latencyMs,
        seqno,
        blocksBehind: 0,
        lastTested: new Date(),
        browserCompatible: true,
    };
}

/** Build a failed (offline, success:false) result for a provider. */
function offline(id: string, network: Network, error: string): ProviderHealthResult {
    return {
        id,
        network,
        success: false,
        status: 'offline',
        latencyMs: null,
        seqno: null,
        blocksBehind: 0,
        lastTested: new Date(),
        error,
        browserCompatible: true,
    };
}

/**
 * A stub HealthChecker exposing only `getResult` — the single method the
 * ProviderSelector consults. Seeded from a fixed result map, so selection is
 * evaluated without any network I/O.
 */
function stubHealthChecker(seed: ProviderHealthResult[]): HealthChecker {
    const results = new Map<string, ProviderHealthResult>();
    for (const r of seed) {
        results.set(`${r.id}-${r.network}`, r);
    }
    const stub = {
        getResult: (providerId: string, network: Network): ProviderHealthResult | undefined =>
            results.get(`${providerId}-${network}`),
    };
    return stub as unknown as HealthChecker;
}

function makeRegistry(): ProviderRegistry {
    // Uses the shipped DEFAULT_PROVIDERS / createDefaultConfig — the config in
    // force for the consumer (bundled-build fallback path), so this test
    // validates the REAL defaults this change edits.
    return new ProviderRegistry(createDefaultConfig(), silentLogger);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n=== Testnet getTransactions selection / failover (offline) ===\n');

// Test 1 — Toncenter must win testnet selection EVEN when Orbs is faster.
// Orbs is given a large latency advantage (50ms vs 400ms) to prove the fix is
// the priority change (not latency): on the OLD priorities (orbs 50 < toncenter
// 100) Orbs would win this; on the FIXED priorities (toncenter 10 < orbs 90)
// Toncenter wins despite the worse latency.
{
    console.log('Test 1: testnet primary = transactions-capable provider (Toncenter)');
    const registry = makeRegistry();
    const checker = stubHealthChecker([
        healthy('orbs_testnet', 'testnet', 50), // faster, but tx-incapable
        healthy('toncenter_testnet', 'testnet', 400), // slower, but serves getTransactions
    ]);
    const selector = createSelector(registry, checker, undefined, silentLogger);
    const best = selector.findBestProvider('testnet');
    check(
        'selects toncenter_testnet for testnet (not Orbs)',
        best?.id === 'toncenter_testnet',
        `selected: ${best?.id ?? 'none'}`,
    );
}

// Test 2 — Failover: when the primary (Toncenter) is offline, the healthy Orbs
// fallback is selected (the system still recovers to an available provider).
{
    console.log('\nTest 2: failover to healthy fallback when primary is offline');
    const registry = makeRegistry();
    const checker = stubHealthChecker([
        offline('toncenter_testnet', 'testnet', 'HTTP 503 Service Unavailable'),
        healthy('orbs_testnet', 'testnet', 50),
    ]);
    const selector = createSelector(registry, checker, undefined, silentLogger);
    const best = selector.findBestProvider('testnet');
    check(
        'fails over to orbs_testnet when toncenter_testnet is offline',
        best?.id === 'orbs_testnet',
        `selected: ${best?.id ?? 'none'}`,
    );

    // getNextProvider (failover path used by handleProviderFailure) must also
    // yield the healthy fallback when the failing primary is excluded.
    const next = selector.getNextProvider('testnet', ['toncenter_testnet']);
    check(
        'getNextProvider(testnet, [toncenter_testnet]) → orbs_testnet',
        next?.id === 'orbs_testnet',
        `next: ${next?.id ?? 'none'}`,
    );
}

// Test 3 — Mainnet must be UNCHANGED: Orbs stays primary on mainnet (priority
// there is untouched), guarding against a cross-network regression.
{
    console.log('\nTest 3: mainnet selection unchanged (Orbs stays primary)');
    const registry = makeRegistry();
    const checker = stubHealthChecker([
        healthy('orbs_mainnet', 'mainnet', 100),
        healthy('toncenter_mainnet', 'mainnet', 100),
    ]);
    const selector = createSelector(registry, checker, undefined, silentLogger);
    const best = selector.findBestProvider('mainnet');
    check(
        'mainnet primary remains orbs_mainnet',
        best?.id === 'orbs_mainnet',
        `selected: ${best?.id ?? 'none'}`,
    );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

console.log('');
if (failures > 0) {
    console.error(`❌ ${failures} assertion(s) failed`);
    process.exit(1);
}
console.log('✅ All selection/failover assertions passed');
