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
    DEFAULT_PROVIDERS,
    ProviderRegistry,
    createSelector,
    HealthChecker,
    type Network,
    type ProviderHealthResult,
    type RpcConfig,
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

/**
 * Like `stubHealthChecker`, but backed by a caller-owned, MUTABLE result map so a
 * test can flip a provider's health mid-run (to simulate a getTransactions 403
 * marking it success:false, exactly as manager.reportError → markDegraded does).
 */
function mutableStubHealthChecker(
    results: Map<string, ProviderHealthResult>,
): HealthChecker {
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

// Test 4 — getTransactions failover ENUMERATION (the NodeAdapter.getTransactions
// fix). This mirrors the real runtime config (rpc.json), where chainstack_testnet
// is priority-1 best and passes the getMasterchainInfo health probe, but 403s on
// the v2 getTransactions call. The new NodeAdapter.getTransactions loop reacts to
// that 403 by calling manager.reportError() (→ markDegraded, success:false +
// cache clear) and re-picking — so selection must walk PAST the incapable best
// provider and land on a transaction-capable one (toncenter_testnet). This test
// reproduces that walk at the selector level (offline): a "403" marks the picked
// provider success:false, then we re-pick, until a capable provider is reached.
{
    console.log(
        '\nTest 4: getTransactions failover walks past a healthy-but-incapable best provider',
    );

    // Config that matches the rpc.json shape: chainstack priority-1 best (403s on
    // getTransactions), toncenter priority-5 (capable), orbs priority-90 fallback.
    const cfg: RpcConfig = {
        version: '1.0',
        providers: {
            chainstack_testnet: {
                name: 'Chainstack Testnet',
                type: 'chainstack',
                network: 'testnet',
                // Static endpoint (no {key}) so it resolves offline with no env.
                endpoints: { v2: 'https://ton-testnet.core.chainstack.com/test/api/v2' },
                rps: 25,
                priority: 1,
                enabled: true,
            },
            toncenter_testnet: { ...DEFAULT_PROVIDERS.toncenter_testnet },
            orbs_testnet: { ...DEFAULT_PROVIDERS.orbs_testnet },
        },
        defaults: {
            testnet: ['chainstack_testnet', 'toncenter_testnet', 'orbs_testnet'],
            mainnet: [],
        },
    };

    const registry = new ProviderRegistry(cfg, silentLogger);
    const results = new Map<string, ProviderHealthResult>();
    // All three pass the health probe (getMasterchainInfo) — the bug is precisely
    // that health ≠ getTransactions capability.
    results.set('chainstack_testnet-testnet', healthy('chainstack_testnet', 'testnet', 30));
    results.set('toncenter_testnet-testnet', healthy('toncenter_testnet', 'testnet', 400));
    results.set('orbs_testnet-testnet', healthy('orbs_testnet', 'testnet', 50));

    const checker = mutableStubHealthChecker(results);
    const selector = createSelector(registry, checker, undefined, silentLogger);

    // Providers that 403 on getTransactions despite a passing health probe.
    const incapable = new Set(['chainstack_testnet', 'orbs_testnet']);
    const tried: string[] = [];
    let landed: string | null = null;

    for (let i = 0; i < 5; i++) {
        const best = selector.getBestProvider('testnet');
        if (!best || tried.includes(best.id)) break;
        tried.push(best.id);
        if (!incapable.has(best.id)) {
            landed = best.id; // capable provider → getTransactions succeeds
            break;
        }
        // Simulate the 403 failover step: manager.reportError → markDegraded sets
        // success:false (a 'forbidden' error scores 0 within cooldown), then the
        // selection cache is cleared so the next pick differs.
        results.set(
            `${best.id}-testnet`,
            offline(best.id, 'testnet', `Provider ${best.id}: HTTP 403 Forbidden`),
        );
        selector.clearCache('testnet');
    }

    check(
        'best provider tried first is chainstack_testnet (priority 1)',
        tried[0] === 'chainstack_testnet',
        `first tried: ${tried[0] ?? 'none'}`,
    );
    check(
        'failover lands on a transaction-capable provider (toncenter_testnet)',
        landed === 'toncenter_testnet',
        `landed: ${landed ?? 'none'}`,
    );
    check(
        'the incapable best provider was tried and then excluded',
        tried.includes('chainstack_testnet') && landed !== 'chainstack_testnet',
        `tried: [${tried.join(', ')}], landed: ${landed ?? 'none'}`,
    );
}

// Test 5 — Capability flag: getTransactions candidate set excludes
// servesGetTransactions:false providers (Chainstack/Orbs) up front, WITHOUT
// affecting get-method best-provider selection. This mirrors
// manager.getTransactionCapableProviders() exactly:
//   selector.getAvailableProviders(network).filter(p => p.servesGetTransactions !== false)
// (the manager method needs a live init() so we exercise the same composition at
// the selector level, which also proves the flag survives config → ResolvedProvider).
{
    console.log(
        '\nTest 5: capability flag excludes Chainstack/Orbs from the getTransactions candidate set',
    );

    // chainstack priority-1 (incapable), toncenter priority-5 (capable),
    // tatum priority-8 (capable), orbs priority-90 (incapable). Static endpoints
    // (no {key}) so they resolve offline with no env.
    const cfg: RpcConfig = {
        version: '1.0',
        providers: {
            chainstack_testnet: {
                name: 'Chainstack Testnet',
                type: 'chainstack',
                network: 'testnet',
                endpoints: { v2: 'https://ton-testnet.core.chainstack.com/test/api/v2' },
                rps: 25,
                priority: 1,
                enabled: true,
                servesGetTransactions: false,
            },
            toncenter_testnet: { ...DEFAULT_PROVIDERS.toncenter_testnet },
            tatum_testnet: {
                name: 'Tatum Testnet',
                type: 'tatum',
                network: 'testnet',
                endpoints: { v2: 'https://ton-testnet.gateway.tatum.io' },
                rps: 3,
                priority: 8,
                enabled: true,
            },
            orbs_testnet: { ...DEFAULT_PROVIDERS.orbs_testnet, servesGetTransactions: false },
        },
        defaults: {
            testnet: ['chainstack_testnet', 'toncenter_testnet', 'tatum_testnet', 'orbs_testnet'],
            mainnet: [],
        },
    };

    const registry = new ProviderRegistry(cfg, silentLogger);
    // All four pass the health probe — capability is independent of health.
    const results = new Map<string, ProviderHealthResult>();
    results.set('chainstack_testnet-testnet', healthy('chainstack_testnet', 'testnet', 30));
    results.set('toncenter_testnet-testnet', healthy('toncenter_testnet', 'testnet', 400));
    results.set('tatum_testnet-testnet', healthy('tatum_testnet', 'testnet', 500));
    results.set('orbs_testnet-testnet', healthy('orbs_testnet', 'testnet', 50));
    const checker = mutableStubHealthChecker(results);
    const selector = createSelector(registry, checker, undefined, silentLogger);

    // (a) candidate set excludes Chainstack/Orbs, includes Toncenter then Tatum.
    const txCapable = selector
        .getAvailableProviders('testnet')
        .filter((p) => p.servesGetTransactions !== false)
        .map((p) => p.id);
    check(
        'getTransactions candidates exclude chainstack_testnet & orbs_testnet',
        !txCapable.includes('chainstack_testnet') && !txCapable.includes('orbs_testnet'),
        `candidates: [${txCapable.join(', ')}]`,
    );
    check(
        'getTransactions candidates are [toncenter_testnet, tatum_testnet] in score order',
        txCapable[0] === 'toncenter_testnet' && txCapable[1] === 'tatum_testnet',
        `candidates: [${txCapable.join(', ')}]`,
    );

    // (b) get-method best-provider selection is UNAFFECTED — still Chainstack.
    const best = selector.getBestProvider('testnet');
    check(
        'get-method best provider is still chainstack_testnet (capability flag does not affect it)',
        best?.id === 'chainstack_testnet',
        `best: ${best?.id ?? 'none'}`,
    );

    // (c) with ALL capable providers failing, the candidate set is empty (the
    // adapter then throws the no-transaction-capable-provider error).
    results.set(
        'toncenter_testnet-testnet',
        offline('toncenter_testnet', 'testnet', 'Provider toncenter_testnet: HTTP 403 Forbidden'),
    );
    results.set(
        'tatum_testnet-testnet',
        offline('tatum_testnet', 'testnet', 'Provider tatum_testnet: HTTP 403 Forbidden'),
    );
    selector.clearCache('testnet');
    const capableWhenAllFailing = selector
        .getAvailableProviders('testnet')
        .filter((p) => p.servesGetTransactions !== false)
        .map((p) => p.id);
    check(
        'no transaction-capable provider remains when all capable ones fail',
        capableWhenAllFailing.length === 0,
        `capable: [${capableWhenAllFailing.join(', ')}]`,
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
