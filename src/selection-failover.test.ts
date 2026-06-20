#!/usr/bin/env tsx
/**
 * OFFLINE regression test — testnet getTransactions provider selection / failover.
 *
 * Context (bug): on testnet the consumer (uap `catch_up`) reads account
 * transactions through this library's selected endpoint. Non-serving providers
 * (Orbs/Chainstack/OnFinality) were selected but only pass the health probe —
 * their v2 `getTransactions` 403s / auth-fails — so every transactions read
 * dead-lettered with no recovery. The fix REMOVES those providers from the
 * testnet default set entirely, leaving only the transaction-capable Toncenter
 * (primary) and Tatum (failover) testnet providers.
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

// Test 1 — With comparable health/latency, Toncenter (priority 1) is preferred
// over Tatum (priority 2): priority breaks the tie (score blends priority+latency,
// so the p1↔p2 gap only decides when latency is even). Both are now the ONLY
// testnet defaults (Orbs/Chainstack/OnFinality removed) and BOTH are
// transaction-capable, so either winning is correct — this asserts the intended
// primary under normal conditions.
{
    console.log('Test 1: testnet primary = transactions-capable provider (Toncenter)');
    const registry = makeRegistry();
    const checker = stubHealthChecker([
        healthy('tatum_testnet', 'testnet', 100), // equal latency, priority 2
        healthy('toncenter_testnet', 'testnet', 100), // equal latency, priority 1 → wins tie
    ]);
    const selector = createSelector(registry, checker, undefined, silentLogger);
    const best = selector.findBestProvider('testnet');
    check(
        'selects toncenter_testnet for testnet (priority tie-break over Tatum)',
        best?.id === 'toncenter_testnet',
        `selected: ${best?.id ?? 'none'}`,
    );
}

// Test 2 — Failover: when the primary (Toncenter) is offline, the healthy Tatum
// fallback is selected (the system still recovers to a transaction-capable
// provider — Tatum is now the only testnet failover target).
{
    console.log('\nTest 2: failover to healthy fallback when primary is offline');
    const registry = makeRegistry();
    const checker = stubHealthChecker([
        offline('toncenter_testnet', 'testnet', 'HTTP 503 Service Unavailable'),
        healthy('tatum_testnet', 'testnet', 50),
    ]);
    const selector = createSelector(registry, checker, undefined, silentLogger);
    const best = selector.findBestProvider('testnet');
    check(
        'fails over to tatum_testnet when toncenter_testnet is offline',
        best?.id === 'tatum_testnet',
        `selected: ${best?.id ?? 'none'}`,
    );

    // getNextProvider (failover path used by handleProviderFailure) must also
    // yield the healthy fallback when the failing primary is excluded.
    const next = selector.getNextProvider('testnet', ['toncenter_testnet']);
    check(
        'getNextProvider(testnet, [toncenter_testnet]) → tatum_testnet',
        next?.id === 'tatum_testnet',
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
            // Orbs is no longer a shipped default; define it inline to exercise the
            // generic getTransactions failover-walk mechanism (still in the library).
            orbs_testnet: {
                name: 'Orbs TON Access Testnet',
                type: 'orbs',
                network: 'testnet',
                endpoints: { v2: 'https://ton-testnet.orbs.network/api/v2' },
                rps: 10,
                priority: 90,
                enabled: true,
                isDynamic: true,
            },
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
            // Orbs is no longer a shipped default; define it inline (with the
            // capability flag) to exercise the generic candidate-set filtering.
            orbs_testnet: {
                name: 'Orbs TON Access Testnet',
                type: 'orbs',
                network: 'testnet',
                endpoints: { v2: 'https://ton-testnet.orbs.network/api/v2' },
                rps: 10,
                priority: 90,
                enabled: true,
                isDynamic: true,
                servesGetTransactions: false,
            },
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

// Test 6 — TRIMMED rpc.json testnet set (this change). Mirrors the shipped
// rpc.json after the fix: the testnet default set is EXACTLY toncenter (priority
// 1, primary) + tatum (priority 2, failover) — the non-serving providers
// (Chainstack/Orbs/OnFinality) are removed entirely. Proves (a) with comparable
// latency toncenter (p1) wins the score tie over tatum (p2), and (b) the available
// pool is exactly [toncenter, tatum] with no removed provider leaking back in via
// the "remaining" append path.
{
    console.log(
        '\nTest 6: trimmed rpc.json testnet set — pool is exactly [toncenter(p1), tatum(p2)]',
    );

    const cfg: RpcConfig = {
        version: '1.0',
        providers: {
            toncenter_testnet: {
                name: 'TON Center Testnet',
                type: 'toncenter',
                network: 'testnet',
                endpoints: { v2: 'https://testnet.toncenter.com/api/v2' },
                rps: 10,
                priority: 1,
                enabled: true,
            },
            tatum_testnet: {
                name: 'Tatum Testnet',
                type: 'tatum',
                network: 'testnet',
                endpoints: { v2: 'https://ton-testnet.gateway.tatum.io' },
                rps: 3,
                priority: 2,
                enabled: true,
            },
        },
        defaults: {
            testnet: ['toncenter_testnet', 'tatum_testnet'],
            mainnet: [],
        },
    };

    const registry = new ProviderRegistry(cfg, silentLogger);
    const checker = stubHealthChecker([
        healthy('toncenter_testnet', 'testnet', 100), // equal latency, priority 1 → wins tie
        healthy('tatum_testnet', 'testnet', 100), // equal latency, priority 2
    ]);
    const selector = createSelector(registry, checker, undefined, silentLogger);

    const best = selector.getBestProvider('testnet');
    check(
        'best testnet provider is toncenter_testnet (priority tie-break at equal latency)',
        best?.id === 'toncenter_testnet',
        `best: ${best?.id ?? 'none'}`,
    );

    const order = selector.getAvailableProviders('testnet').map((p) => p.id);
    check(
        'available pool is exactly [toncenter, tatum] (no removed provider leaks in)',
        order.length === 2 &&
            order[0] === 'toncenter_testnet' &&
            order[1] === 'tatum_testnet',
        `order: [${order.join(', ')}]`,
    );
}

// Test 7 — BROADCAST (sendBoc) failover. The new NodeAdapter.sendBoc walks the
// broadcast candidate set (ProviderManager.getBroadcastCapableProviders =
// selector.getAvailableProviders, NO servesGetTransactions filter) and, on a
// TRANSIENT failure (here a 500 on the picked provider), calls
// reportError → markOffline (success:false) and re-picks the next provider. This
// reproduces that walk offline at the selector level (no live HTTP). It also
// asserts the broadcast candidate set is capability-AGNOSTIC: chainstack
// (servesGetTransactions:false) is a valid broadcast target, unlike the
// getTransactions set which excludes it.
{
    console.log(
        '\nTest 7: sendBoc broadcast fails over a 5xx provider to a healthy one (capability-agnostic)',
    );

    const cfg: RpcConfig = {
        version: '1.0',
        providers: {
            toncenter_testnet: {
                name: 'TON Center Testnet',
                type: 'toncenter',
                network: 'testnet',
                endpoints: { v2: 'https://testnet.toncenter.com/api/v2' },
                rps: 10,
                priority: 1,
                enabled: true,
            },
            tatum_testnet: {
                name: 'Tatum Testnet',
                type: 'tatum',
                network: 'testnet',
                endpoints: { v2: 'https://ton-testnet.gateway.tatum.io' },
                rps: 3,
                priority: 2,
                enabled: true,
            },
            chainstack_testnet: {
                name: 'Chainstack Testnet',
                type: 'chainstack',
                network: 'testnet',
                endpoints: { v2: 'https://ton-testnet.core.chainstack.com/test/api/v2' },
                rps: 25,
                priority: 50,
                enabled: true,
                servesGetTransactions: false, // incapable of getTransactions...
            },
        },
        defaults: {
            testnet: ['toncenter_testnet', 'tatum_testnet', 'chainstack_testnet'],
            mainnet: [],
        },
    };

    const registry = new ProviderRegistry(cfg, silentLogger);
    const results = new Map<string, ProviderHealthResult>();
    results.set('toncenter_testnet-testnet', healthy('toncenter_testnet', 'testnet', 400));
    results.set('tatum_testnet-testnet', healthy('tatum_testnet', 'testnet', 500));
    results.set('chainstack_testnet-testnet', healthy('chainstack_testnet', 'testnet', 30));
    const checker = mutableStubHealthChecker(results);
    const selector = createSelector(registry, checker, undefined, silentLogger);

    // (a) the broadcast candidate set INCLUDES chainstack (capability-agnostic),
    // unlike the getTransactions set which filters it out.
    const broadcastCandidates = selector.getAvailableProviders('testnet').map((p) => p.id);
    const txCandidates = selector
        .getAvailableProviders('testnet')
        .filter((p) => p.servesGetTransactions !== false)
        .map((p) => p.id);
    check(
        'broadcast candidates include chainstack_testnet',
        broadcastCandidates.includes('chainstack_testnet'),
        `broadcast: [${broadcastCandidates.join(', ')}]`,
    );
    check(
        'getTransactions candidates exclude chainstack_testnet (contrast)',
        !txCandidates.includes('chainstack_testnet'),
        `tx: [${txCandidates.join(', ')}]`,
    );

    // (b) simulate the sendBoc loop: best (toncenter) 500s → mark offline + re-pick.
    const failing = new Set(['toncenter_testnet']); // 500s on sendBoc
    const tried: string[] = [];
    let landed: string | null = null;
    for (let i = 0; i < 5; i++) {
        const best = selector.getBestProvider('testnet');
        if (!best || tried.includes(best.id)) break;
        tried.push(best.id);
        if (!failing.has(best.id)) {
            landed = best.id; // healthy on broadcast → sendBoc succeeds
            break;
        }
        // Transient 5xx → manager.reportError → markOffline (success:false) + cache clear.
        results.set(
            `${best.id}-testnet`,
            offline(best.id, 'testnet', `Provider ${best.id}: HTTP 500 Internal Server Error`),
        );
        selector.clearCache('testnet');
    }
    check(
        'broadcast tried toncenter_testnet first (priority 1)',
        tried[0] === 'toncenter_testnet',
        `first: ${tried[0] ?? 'none'}`,
    );
    check(
        'broadcast fails over to the next healthy provider (tatum_testnet)',
        landed === 'tatum_testnet',
        `landed: ${landed ?? 'none'}`,
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
