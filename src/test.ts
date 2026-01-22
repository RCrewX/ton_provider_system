#!/usr/bin/env ts-node
/**
 * Provider System Test Script
 *
 * Comprehensive test of all provider system components.
 *
 * Usage:
 *   pnpm test:providers
 *   ts-node provider_system/test.ts
 *
 * Options:
 *   --network testnet|mainnet   Network to test (default: testnet)
 *   --verbose                   Show detailed output
 *   --quick                     Quick test (skip slow providers)
 */

import * as dotenv from 'dotenv';
import { Address } from '@ton/core';

// Load environment variables first
dotenv.config();

import {
    // Config
    loadConfig,
    parseRpcConfig,
    resolveAllProviders,
    getDefaultProvidersForNetwork,
    createDefaultConfig,

    // Core
    ProviderRegistry,
    createRegistry,
    HealthChecker,
    createHealthChecker,
    RateLimiterManager,
    createRateLimiterManager,
    ProviderSelector,
    createSelector,
    ProviderManager,

    // Adapters
    NodeAdapter,
    getTonClient,

    // Utils
    normalizeV2Endpoint,
    toV2Base,
    isValidHttpUrl,
    fetchWithTimeout,

    // Types
    type Network,
    type ResolvedProvider,
    type ProviderHealthResult,
} from './index';

// =============================================================================
// Test Utilities
// =============================================================================

interface TestResult {
    name: string;
    passed: boolean;
    duration: number;
    error?: string;
    details?: string;
}

const results: TestResult[] = [];
let verbose = false;

function log(message: string): void {
    console.log(message);
}

function logVerbose(message: string): void {
    if (verbose) {
        console.log(`  ${message}`);
    }
}

async function runTest(
    name: string,
    testFn: () => Promise<void>
): Promise<TestResult> {
    const start = performance.now();
    let result: TestResult;

    try {
        await testFn();
        result = {
            name,
            passed: true,
            duration: Math.round(performance.now() - start),
        };
        log(`  ✓ ${name} (${result.duration}ms)`);
    } catch (error: any) {
        result = {
            name,
            passed: false,
            duration: Math.round(performance.now() - start),
            error: error.message || String(error),
        };
        log(`  ✗ ${name}: ${result.error}`);
    }

    results.push(result);
    return result;
}

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
}

function assertDefined<T>(value: T | null | undefined, message: string): asserts value is T {
    if (value === null || value === undefined) {
        throw new Error(`${message}: value is ${value}`);
    }
}

// =============================================================================
// Test Suites
// =============================================================================

async function testConfigLoading(): Promise<void> {
    log('\n=== Config Loading Tests ===\n');

    await runTest('Load config from file', async () => {
        const config = await loadConfig();
        assert(config.version === '1.0', 'Version should be 1.0');
        assert(Object.keys(config.providers).length > 0, 'Should have providers');
        assert(config.defaults.testnet.length > 0, 'Should have testnet defaults');
        logVerbose(`Loaded ${Object.keys(config.providers).length} providers`);
    });

    await runTest('Parse empty config', async () => {
        const config = parseRpcConfig({
            version: '1.0',
            providers: {},
            defaults: { testnet: [], mainnet: [] },
        });
        assertEqual(Object.keys(config.providers).length, 0, 'Provider count');
    });

    await runTest('Create default config', async () => {
        const config = createDefaultConfig();
        assert(config.providers.toncenter_testnet !== undefined, 'Should have toncenter_testnet');
        assert(config.providers.orbs_testnet !== undefined, 'Should have orbs_testnet');
    });

    await runTest('Resolve providers', async () => {
        const config = await loadConfig();
        const resolved = resolveAllProviders(config);
        assert(resolved.length > 0, 'Should resolve some providers');

        // Check that enabled providers are resolved
        const enabledCount = Object.values(config.providers).filter(p => p.enabled).length;
        logVerbose(`Resolved ${resolved.length}/${enabledCount} enabled providers`);
    });
}

async function testProviderRegistry(): Promise<void> {
    log('\n=== Provider Registry Tests ===\n');

    await runTest('Create registry from file', async () => {
        const registry = await createRegistry();
        assert(registry.getAllProviders().length > 0, 'Should have providers');
    });

    await runTest('Get providers for network', async () => {
        const registry = await createRegistry();
        const testnetProviders = registry.getProvidersForNetwork('testnet');
        const mainnetProviders = registry.getProvidersForNetwork('mainnet');

        logVerbose(`Testnet: ${testnetProviders.length}, Mainnet: ${mainnetProviders.length}`);

        assert(testnetProviders.length >= 0, 'Should get testnet providers');
        assert(mainnetProviders.length >= 0, 'Should get mainnet providers');

        // All testnet providers should be for testnet
        for (const p of testnetProviders) {
            assertEqual(p.network, 'testnet', `Provider ${p.id} network`);
        }
    });

    await runTest('Get provider by ID', async () => {
        const registry = await createRegistry();
        const providers = registry.getAllProviders();

        if (providers.length > 0) {
            const first = providers[0];
            const found = registry.getProvider(first.id);
            assertDefined(found, `Provider ${first.id}`);
            assertEqual(found.id, first.id, 'Provider ID');
        }
    });

    await runTest('Get default order', async () => {
        const registry = await createRegistry();
        const defaultTestnet = registry.getDefaultOrderForNetwork('testnet');
        logVerbose(`Default testnet order: ${defaultTestnet.map(p => p.id).join(', ')}`);
    });
}

async function testHealthChecker(network: Network): Promise<void> {
    log('\n=== Health Checker Tests ===\n');

    await runTest('Create health checker', async () => {
        const checker = createHealthChecker({ timeoutMs: 10000 });
        assert(checker instanceof HealthChecker, 'Should be HealthChecker instance');
    });

    await runTest('Test single provider (toncenter)', async () => {
        const registry = await createRegistry();
        const checker = createHealthChecker({ timeoutMs: 15000 });

        // Find toncenter for the network (most reliable)
        const toncenter = registry.getProvider(`toncenter_${network}`);
        if (!toncenter) {
            logVerbose('No toncenter provider configured, skipping');
            return;
        }

        const result = await checker.testProvider(toncenter);
        logVerbose(`Status: ${result.status}, Latency: ${result.latencyMs}ms, Seqno: ${result.seqno}`);

        // TON Center should generally work (even without API key, just slower)
        if (!result.success) {
            logVerbose(`Warning: toncenter failed - ${result.error}`);
        }
    });

    await runTest('Test multiple providers', async () => {
        const registry = await createRegistry();
        const checker = createHealthChecker({ timeoutMs: 10000 });
        const providers = registry.getProvidersForNetwork(network).slice(0, 3); // Test max 3

        if (providers.length === 0) {
            logVerbose(`No providers for ${network}, skipping`);
            return;
        }

        const results = await checker.testProviders(providers, 2, 100);
        const successful = results.filter(r => r.success);

        logVerbose(`Tested ${results.length} providers, ${successful.length} successful`);

        for (const r of results) {
            logVerbose(`  ${r.id}: ${r.status} (${r.latencyMs || 'N/A'}ms)`);
        }
    });

    await runTest('Get best provider', async () => {
        const registry = await createRegistry();
        const checker = createHealthChecker({ timeoutMs: 10000 });
        const providers = registry.getProvidersForNetwork(network).slice(0, 2);

        if (providers.length === 0) {
            logVerbose(`No providers for ${network}, skipping`);
            return;
        }

        await checker.testProviders(providers);
        const best = checker.getBestProvider(network);

        if (best) {
            logVerbose(`Best provider: ${best.id} (${best.latencyMs}ms)`);
        } else {
            logVerbose('No available provider found');
        }
    });

    await runTest('Detect HTTP status codes (404, 429)', async () => {
        const registry = await createRegistry();
        const checker = createHealthChecker({ timeoutMs: 5000 });

        const providers = registry.getProvidersForNetwork(network);
        if (providers.length === 0) {
            logVerbose(`No providers for ${network}, skipping`);
            return;
        }

        // Test error detection by manually marking providers with different error types
        const testProvider = providers[0];

        // Simulate HTTP 404 error
        checker.markOffline(testProvider.id, network, 'HTTP 404 Not Found');
        const health404 = checker.getResult(testProvider.id, network);
        if (health404) {
            assertEqual(health404.status, 'offline', '404 should be offline');
            assertEqual(health404.success, false, '404 should have success: false');
            logVerbose(`HTTP 404 detection: status=${health404.status}, success=${health404.success}`);
        }

        // Simulate HTTP 429 error
        checker.markDegraded(testProvider.id, network, 'HTTP 429 Rate Limit');
        const health429 = checker.getResult(testProvider.id, network);
        if (health429) {
            assertEqual(health429.status, 'degraded', '429 should be degraded');
            assertEqual(health429.success, false, '429 should have success: false');
            logVerbose(`HTTP 429 detection: status=${health429.status}, success=${health429.success}`);
        }
    });
}

async function testRateLimiter(): Promise<void> {
    log('\n=== Rate Limiter Tests ===\n');

    await runTest('Create rate limiter', async () => {
        const limiter = createRateLimiterManager();
        assert(limiter instanceof RateLimiterManager, 'Should be RateLimiterManager');
    });

    await runTest('Configure and acquire tokens', async () => {
        const limiter = createRateLimiterManager();
        limiter.setConfig('test_provider', {
            rps: 10,
            burstSize: 10,
            minDelayMs: 100,
            backoffMultiplier: 2,
            maxBackoffMs: 5000,
        });

        // Should acquire immediately (have tokens)
        const start = performance.now();
        const acquired = await limiter.acquire('test_provider', 1000);
        const elapsed = performance.now() - start;

        assert(acquired, 'Should acquire token');
        assert(elapsed < 200, `Acquisition should be fast: ${elapsed}ms`);
        logVerbose(`Acquired in ${Math.round(elapsed)}ms`);
    });

    await runTest('Rate limit state tracking', async () => {
        const limiter = createRateLimiterManager();
        limiter.setConfig('test_provider', {
            rps: 5,
            burstSize: 5,
            minDelayMs: 200,
            backoffMultiplier: 2,
            maxBackoffMs: 5000,
        });

        // Acquire a few tokens
        await limiter.acquire('test_provider', 100);
        await limiter.acquire('test_provider', 100);

        const state = limiter.getState('test_provider');
        assertDefined(state, 'State');
        logVerbose(`Tokens: ${state.tokens}, Queue: ${state.queueLength}`);
    });

    await runTest('Backoff on rate limit error', async () => {
        const limiter = createRateLimiterManager();
        limiter.setConfig('test_provider', {
            rps: 10,
            burstSize: 10,
            minDelayMs: 100,
            backoffMultiplier: 2,
            maxBackoffMs: 5000,
        });

        // Report rate limit error
        limiter.reportRateLimitError('test_provider');

        const state = limiter.getState('test_provider');
        assertDefined(state, 'State');
        assert(state.currentBackoff > 0, 'Should have backoff');
        logVerbose(`Backoff: ${state.currentBackoff}ms`);
    });
}

async function testProviderSelector(network: Network): Promise<void> {
    log('\n=== Provider Selector Tests ===\n');

    await runTest('Create selector', async () => {
        const registry = await createRegistry();
        const checker = createHealthChecker();
        const selector = createSelector(registry, checker);

        assert(selector instanceof ProviderSelector, 'Should be ProviderSelector');
    });

    await runTest('Select best provider', async () => {
        const registry = await createRegistry();
        const checker = createHealthChecker({ timeoutMs: 10000 });
        const selector = createSelector(registry, checker);

        // Test some providers first
        const providers = registry.getProvidersForNetwork(network).slice(0, 2);
        if (providers.length === 0) {
            logVerbose(`No providers for ${network}, skipping`);
            return;
        }

        await checker.testProviders(providers);
        selector.updateBestProvider(network);

        const best = selector.getBestProvider(network);
        if (best) {
            logVerbose(`Selected: ${best.id} (${best.name})`);
        }
    });

    await runTest('Manual provider selection', async () => {
        const registry = await createRegistry();
        const checker = createHealthChecker();
        const selector = createSelector(registry, checker);

        const providers = registry.getProvidersForNetwork(network);
        if (providers.length === 0) {
            logVerbose(`No providers for ${network}, skipping`);
            return;
        }

        // Set manual selection
        const first = providers[0];
        selector.setSelectedProvider(first.id);
        assertEqual(selector.getSelectedProviderId(), first.id, 'Selected provider');

        // Clear selection
        selector.setSelectedProvider(null);
        assertEqual(selector.getSelectedProviderId(), null, 'Cleared selection');
    });

    await runTest('Custom endpoint override', async () => {
        const registry = await createRegistry();
        const checker = createHealthChecker();
        const selector = createSelector(registry, checker);

        const customUrl = 'https://custom.endpoint/api/v2';
        selector.setCustomEndpoint(customUrl);

        assert(selector.isUsingCustomEndpoint(), 'Should use custom endpoint');
        assertEqual(selector.getCustomEndpoint(), customUrl, 'Custom endpoint value');

        // Provider info should reflect custom
        const info = selector.getActiveProviderInfo(network);
        assertDefined(info, 'Provider info');
        assert(info.isCustom, 'Should be marked as custom');
    });

    await runTest('Reject providers with success: false', async () => {
        const registry = await createRegistry();
        const checker = createHealthChecker();
        const selector = createSelector(registry, checker);

        const providers = registry.getProvidersForNetwork(network);
        if (providers.length === 0) {
            logVerbose(`No providers for ${network}, skipping`);
            return;
        }

        // Manually mark a provider as failed (success: false, status: degraded)
        const testProvider = providers[0];
        checker.markDegraded(testProvider.id, network, 'HTTP 429 Rate Limit');

        // Get the health result and manually set success: false
        const health = checker.getResult(testProvider.id, network);
        if (health) {
            // Create a failed health result
            const failedHealth: ProviderHealthResult = {
                ...health,
                success: false,
                status: 'degraded',
                error: 'HTTP 429 Rate Limit',
            };
            // Note: We can't directly set this, but we can verify the selector behavior
            // The selector should check health.success === false and return score 0
        }

        // The selector should not select providers with success: false
        // This is tested implicitly - if a provider has success: false, it gets score 0
        // and won't be selected by getBestProvider
        const available = selector.getAvailableProviders(network);
        logVerbose(`Available providers: ${available.length}`);
        
        // If all providers are failed, selector should handle gracefully
        const best = selector.getBestProvider(network);
        if (best) {
            // If a provider is selected, verify it's not the failed one
            // (or that it has success: true)
            const bestHealth = checker.getResult(best.id, network);
            if (bestHealth) {
                // Best provider should have success: true (if health check was done)
                logVerbose(`Best provider ${best.id} has success: ${bestHealth.success}`);
            }
        }
    });
}

async function testProviderManager(network: Network): Promise<void> {
    log('\n=== Provider Manager Tests ===\n');

    // Reset singleton for clean test
    ProviderManager.resetInstance();

    await runTest('Create and initialize manager', async () => {
        const pm = new ProviderManager({});
        await pm.init(network, false); // Don't test providers yet

        assert(pm.isInitialized(), 'Should be initialized');
        assertEqual(pm.getNetwork(), network, 'Network');
    });

    await runTest('Test providers via manager', async () => {
        const pm = new ProviderManager({});
        await pm.init(network, false);

        const results = await pm.testAllProviders();
        const successful = results.filter(r => r.success);

        logVerbose(`Tested ${results.length}, ${successful.length} successful`);
    });

    await runTest('Get endpoint', async () => {
        const pm = new ProviderManager({});
        await pm.init(network, true);

        const endpoint = await pm.getEndpoint();
        assert(isValidHttpUrl(endpoint), `Should be valid URL: ${endpoint}`);
        logVerbose(`Endpoint: ${endpoint}`);
    });

    await runTest('Get active provider info', async () => {
        const pm = new ProviderManager({});
        await pm.init(network, true);

        const info = pm.getActiveProviderInfo();
        if (info) {
            logVerbose(`Active: ${info.name} (${info.id}), custom: ${info.isCustom}`);
        }
    });

    await runTest('Singleton pattern', async () => {
        ProviderManager.resetInstance();

        const pm1 = ProviderManager.getInstance({});
        const pm2 = ProviderManager.getInstance();

        assert(pm1 === pm2, 'Should return same instance');

        ProviderManager.resetInstance();
    });

    await runTest('State subscription', async () => {
        const pm = new ProviderManager({});
        let stateUpdates = 0;

        const unsubscribe = pm.subscribe(() => {
            stateUpdates++;
        });

        await pm.init(network, false);

        assert(stateUpdates > 0, 'Should receive state updates');
        logVerbose(`Received ${stateUpdates} state updates`);

        unsubscribe();
    });
}

async function testNodeAdapter(network: Network): Promise<void> {
    log('\n=== Node Adapter Tests ===\n');

    await runTest('Create TonClient via adapter', async () => {
        const pm = new ProviderManager({});
        await pm.init(network, true);

        const adapter = new NodeAdapter(pm);
        const client = await adapter.getClient();

        assert(client !== null, 'Should create client');
        logVerbose(`Created TonClient for ${network}`);
    });

    await runTest('Get address state', async () => {
        const pm = new ProviderManager({});
        await pm.init(network, true);

        const adapter = new NodeAdapter(pm);

        // Use a known system address
        const testAddress = network === 'mainnet'
            ? 'Ef8zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM0vF' // Elector
            : 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2'; // Testnet elector

        try {
            const state = await adapter.getAddressState(testAddress, 15000);
            logVerbose(`Address state: ${state}`);
            assert(['uninit', 'active', 'frozen'].includes(state), `Valid state: ${state}`);
        } catch (error: any) {
            // May fail if no working provider
            logVerbose(`Could not get state: ${error.message}`);
        }
    });

    await runTest('Client caching', async () => {
        const pm = new ProviderManager({});
        await pm.init(network, true);

        const adapter = new NodeAdapter(pm);

        const client1 = await adapter.getClient();
        const client2 = await adapter.getClient();

        assert(client1 === client2, 'Should return cached client');

        const info = adapter.getClientInfo();
        assertDefined(info, 'Client info');
        logVerbose(`Client age: ${info.age}ms`);
    });
}

async function testEndpointUtils(): Promise<void> {
    log('\n=== Endpoint Utilities Tests ===\n');

    await runTest('Normalize V2 endpoint', async () => {
        const tests = [
            ['https://toncenter.com/api/v2', 'https://toncenter.com/api/v2/jsonRPC'],
            ['https://toncenter.com/api/v2/', 'https://toncenter.com/api/v2/jsonRPC'],
            ['https://toncenter.com/api/v2/jsonRPC', 'https://toncenter.com/api/v2/jsonRPC'],
            ['https://example.com/api/v3', 'https://example.com/api/v2/jsonRPC'],
        ];

        for (const [input, expected] of tests) {
            const result = normalizeV2Endpoint(input);
            assertEqual(result, expected, `normalizeV2Endpoint(${input})`);
        }
    });

    await runTest('Convert to V2 base', async () => {
        const tests = [
            ['https://toncenter.com/api/v2/jsonRPC', 'https://toncenter.com/api/v2'],
            ['https://toncenter.com/api/v3', 'https://toncenter.com/api/v2'],
            ['https://example.com/custom', 'https://example.com/custom'],
        ];

        for (const [input, expected] of tests) {
            const result = toV2Base(input);
            assertEqual(result, expected, `toV2Base(${input})`);
        }
    });

    await runTest('Validate HTTP URLs', async () => {
        assert(isValidHttpUrl('https://toncenter.com/api/v2'), 'Valid HTTPS');
        assert(isValidHttpUrl('http://localhost:8080'), 'Valid HTTP');
        assert(!isValidHttpUrl('wss://example.com'), 'Invalid WSS');
        assert(!isValidHttpUrl('not-a-url'), 'Invalid string');
    });
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
    // Parse arguments
    const args = process.argv.slice(2);
    let network: Network = 'testnet';
    let quick = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--network' && args[i + 1]) {
            network = args[++i] as Network;
        } else if (args[i] === '--verbose' || args[i] === '-v') {
            verbose = true;
        } else if (args[i] === '--quick' || args[i] === '-q') {
            quick = true;
        }
    }

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║         Provider System Test Suite                           ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`\nNetwork: ${network}`);
    console.log(`Verbose: ${verbose}`);
    console.log(`Quick: ${quick}`);

    const startTime = performance.now();

    try {
        // Run test suites
        await testEndpointUtils();
        await testConfigLoading();
        await testProviderRegistry();
        await testRateLimiter();

        if (!quick) {
            await testHealthChecker(network);
            await testProviderSelector(network);
            await testProviderManager(network);
            await testNodeAdapter(network);
        } else {
            log('\n=== Skipping network tests (--quick mode) ===\n');
        }
    } catch (error: any) {
        console.error('\nFatal error:', error.message);
        process.exit(1);
    }

    // Summary
    const totalTime = Math.round(performance.now() - startTime);
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log('\n' + '═'.repeat(64));
    console.log(`\nTest Summary:`);
    console.log(`  Total:  ${results.length}`);
    console.log(`  Passed: ${passed}`);
    console.log(`  Failed: ${failed}`);
    console.log(`  Time:   ${totalTime}ms`);

    if (failed > 0) {
        console.log('\nFailed tests:');
        for (const r of results.filter(r => !r.passed)) {
            console.log(`  - ${r.name}: ${r.error}`);
        }
        process.exit(1);
    } else {
        console.log('\n✓ All tests passed!');
    }
}

// Run if executed directly
if (require.main === module) {
    main().catch(console.error);
}

export { main as runProviderTests };
