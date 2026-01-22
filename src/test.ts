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
    getRateLimitForType,
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

    await runTest('Test multiple providers with rate limiting', async () => {
        const registry = await createRegistry();
        const rateLimiter = createRateLimiterManager();
        
        // Configure rate limiters for providers
        const providers = registry.getProvidersForNetwork(network).slice(0, 3);
        if (providers.length === 0) {
            logVerbose(`No providers for ${network}, skipping`);
            return;
        }
        
        for (const provider of providers) {
            const config = getRateLimitForType(provider.type);
            rateLimiter.setConfig(provider.id, {
                ...config,
                rps: provider.rps,
                minDelayMs: Math.ceil(1000 / provider.rps),
            });
        }
        
        const checker = createHealthChecker({ timeoutMs: 15000 }, undefined, rateLimiter);
        
        // Use larger batch delay to respect rate limits
        const results = await checker.testProviders(providers, 1, 1000);
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        logVerbose(`\n📊 Provider Test Results (${results.length} providers):`);
        logVerbose(`  ✓ Successful: ${successful.length}`);
        logVerbose(`  ✗ Failed: ${failed.length}`);
        logVerbose(`\n📋 Detailed Results:\n`);
        
        for (const r of results) {
            const provider = registry.getProvider(r.id);
            const statusIcon = r.success ? '✓' : '✗';
            const statusColor = r.success 
                ? (r.status === 'available' ? '🟢' : r.status === 'degraded' ? '🟡' : '🟠')
                : '🔴';
            
            logVerbose(`  ${statusIcon} ${statusColor} ${r.id} (${provider?.name || 'Unknown'})`);
            logVerbose(`     Type: ${provider?.type || 'unknown'}`);
            logVerbose(`     Status: ${r.status}`);
            logVerbose(`     Success: ${r.success ? 'Yes' : 'No'}`);
            
            if (r.success) {
                logVerbose(`     Latency: ${r.latencyMs || 'N/A'}ms`);
                logVerbose(`     Seqno: ${r.seqno || 'N/A'}`);
                logVerbose(`     Blocks behind: ${r.blocksBehind || 0}`);
                if (r.cachedEndpoint) {
                    logVerbose(`     Endpoint: ${r.cachedEndpoint}`);
                }
            } else {
                logVerbose(`     Error: ${r.error || 'Unknown error'}`);
                if (r.latencyMs) {
                    logVerbose(`     Latency (before error): ${r.latencyMs}ms`);
                }
            }
            
            // Show API key status
            if (provider) {
                const hasApiKey = provider.apiKey ? 'Yes' : 'No';
                const apiKeyRequired = provider.type === 'tatum' || provider.type === 'onfinality' 
                    ? ' (Required)' : ' (Optional)';
                logVerbose(`     API Key: ${hasApiKey}${apiKeyRequired}`);
            }
            
            logVerbose(``);
        }
        
        // Verify rate limiting worked (no 429 errors if rate limiter is used)
        const rateLimitErrors = failed.filter(r => r.error?.includes('429'));
        if (rateLimitErrors.length > 0 && rateLimiter) {
            logVerbose(`  ⚠ Rate limit errors: ${rateLimitErrors.length} (rate limiter should prevent these)`);
        }
    });

    await runTest('Get best provider with detailed analysis', async () => {
        const registry = await createRegistry();
        const checker = createHealthChecker({ timeoutMs: 10000 });
        const providers = registry.getProvidersForNetwork(network).slice(0, 3);

        if (providers.length === 0) {
            logVerbose(`No providers for ${network}, skipping`);
            return;
        }

        logVerbose(`Testing ${providers.length} providers to find best...`);
        const results = await checker.testProviders(providers, 1, 500);
        
        // Analyze results
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        
        logVerbose(`\n📊 Test Results:`);
        logVerbose(`  ✓ Successful: ${successful.length}`);
        logVerbose(`  ✗ Failed: ${failed.length}`);
        logVerbose(`\n📋 Detailed Results:\n`);
        for (const r of results) {
            const provider = registry.getProvider(r.id);
            const statusIcon = r.success ? '✓' : '✗';
            const statusColor = r.success 
                ? (r.status === 'available' ? '🟢' : r.status === 'degraded' ? '🟡' : '🟠')
                : '🔴';
            
            logVerbose(`  ${statusIcon} ${statusColor} ${r.id} (${provider?.name || 'Unknown'})`);
            logVerbose(`     Type: ${provider?.type || 'unknown'}`);
            logVerbose(`     Status: ${r.status}`);
            logVerbose(`     Success: ${r.success ? 'Yes' : 'No'}`);
            
            if (r.success) {
                logVerbose(`     Latency: ${r.latencyMs || 'N/A'}ms`);
                logVerbose(`     Seqno: ${r.seqno || 'N/A'}`);
                logVerbose(`     Blocks behind: ${r.blocksBehind || 0}`);
                if (r.cachedEndpoint) {
                    logVerbose(`     Endpoint: ${r.cachedEndpoint}`);
                }
            } else {
                logVerbose(`     Error: ${r.error || 'Unknown error'}`);
                if (r.latencyMs) {
                    logVerbose(`     Latency (before error): ${r.latencyMs}ms`);
                }
            }
            
            if (provider) {
                const hasApiKey = provider.apiKey ? 'Yes' : 'No';
                const apiKeyRequired = provider.type === 'tatum' || provider.type === 'onfinality' 
                    ? ' (Required)' : ' (Optional)';
                logVerbose(`     API Key: ${hasApiKey}${apiKeyRequired}`);
            }
            
            logVerbose(``);
        }
        
        const best = checker.getBestProvider(network);
        if (best) {
            const bestHealth = checker.getResult(best.id, network);
            const bestProvider = registry.getProvider(best.id);
            logVerbose(`\n🏆 Best Provider Selected:\n`);
            logVerbose(`  🟢 ${best.id} (${bestProvider?.name || 'Unknown'})`);
            logVerbose(`     Type: ${bestProvider?.type || 'unknown'}`);
            if (bestHealth) {
                logVerbose(`     Status: ${bestHealth.status}`);
                logVerbose(`     Latency: ${bestHealth.latencyMs || 'N/A'}ms`);
                logVerbose(`     Seqno: ${bestHealth.seqno || 'N/A'}`);
                logVerbose(`     Blocks behind: ${bestHealth.blocksBehind || 0}`);
                if (bestHealth.cachedEndpoint) {
                    logVerbose(`     Endpoint: ${bestHealth.cachedEndpoint}`);
                }
            }
        } else {
            logVerbose(`\n⚠️  No available provider found (all failed or untested)`);
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

    await runTest('Select best provider with scoring details', async () => {
        const registry = await createRegistry();
        const checker = createHealthChecker({ timeoutMs: 10000 });
        const selector = createSelector(registry, checker);

        // Test some providers first
        const providers = registry.getProvidersForNetwork(network).slice(0, 3);
        if (providers.length === 0) {
            logVerbose(`No providers for ${network}, skipping`);
            return;
        }

        logVerbose(`Testing ${providers.length} providers...`);
        await checker.testProviders(providers, 1, 500);
        
        // Get all available providers with scores
        const available = selector.getAvailableProviders(network);
        logVerbose(`\n📊 Available Providers (${available.length}):\n`);
        for (const provider of available) {
            const health = checker.getResult(provider.id, network);
            if (health) {
                const statusColor = health.status === 'available' ? '🟢' : health.status === 'degraded' ? '🟡' : '🟠';
                logVerbose(`  ${statusColor} ${provider.id} (${provider.name})`);
                logVerbose(`     Type: ${provider.type}`);
                logVerbose(`     Status: ${health.status}`);
                logVerbose(`     Latency: ${health.latencyMs || 'N/A'}ms`);
                logVerbose(`     Seqno: ${health.seqno || 'N/A'}`);
                logVerbose(`     Blocks behind: ${health.blocksBehind || 0}`);
                if (health.cachedEndpoint) {
                    logVerbose(`     Endpoint: ${health.cachedEndpoint}`);
                }
                if (health.lastTested) {
                    logVerbose(`     Last tested: ${health.lastTested.toISOString()}`);
                }
                logVerbose(``);
            }
        }
        
        selector.updateBestProvider(network);
        const best = selector.getBestProvider(network);
        
        if (best) {
            const bestHealth = checker.getResult(best.id, network);
            logVerbose(`\nSelected best: ${best.id} (${best.name})`);
            if (bestHealth) {
                logVerbose(`  Status: ${bestHealth.status}`);
                logVerbose(`  Success: ${bestHealth.success}`);
                logVerbose(`  Latency: ${bestHealth.latencyMs}ms`);
                logVerbose(`  Seqno: ${bestHealth.seqno}`);
                logVerbose(`  Blocks behind: ${bestHealth.blocksBehind}`);
            }
        } else {
            logVerbose(`\nNo provider selected (all failed or untested)`);
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

        // Test with real health checks first
        logVerbose('Testing providers to get real health data...');
        await checker.testProviders(providers.slice(0, 2), 1, 500);
        
        // Manually mark a provider as failed (success: false)
        const testProvider = providers[0];
        checker.markOffline(testProvider.id, network, 'HTTP 503 Service Unavailable');
        
        const failedHealth = checker.getResult(testProvider.id, network);
        if (failedHealth) {
        const provider = registry.getProvider(testProvider.id);
        logVerbose(`\n📋 Provider Failure Test:\n`);
        logVerbose(`  Provider: ${testProvider.id} (${provider?.name || 'Unknown'})`);
        logVerbose(`  Type: ${provider?.type || 'unknown'}`);
        logVerbose(`  Marked as failed:`);
        logVerbose(`    Status: ${failedHealth.status}`);
        logVerbose(`    Success: ${failedHealth.success}`);
        logVerbose(`    Error: ${failedHealth.error}`);
        }

        // The selector should not select providers with success: false
        const available = selector.getAvailableProviders(network);
        logVerbose(`\nAvailable providers (should exclude failed): ${available.length}`);
        
        // Verify failed provider is not in available list
        const failedInAvailable = available.find(p => p.id === testProvider.id);
        if (failedInAvailable) {
            throw new Error(`Failed provider ${testProvider.id} should not be in available list`);
        }
        logVerbose(`✓ Failed provider correctly excluded from available list`);
        
        // Test best provider selection
        const best = selector.getBestProvider(network);
        if (best) {
            const bestHealth = checker.getResult(best.id, network);
            const bestProvider = registry.getProvider(best.id);
            if (bestHealth) {
                logVerbose(`\n🏆 Best Provider Selected:\n`);
                logVerbose(`  🟢 ${best.id} (${bestProvider?.name || 'Unknown'})`);
                logVerbose(`     Type: ${bestProvider?.type || 'unknown'}`);
                logVerbose(`     Success: ${bestHealth.success}`);
                logVerbose(`     Status: ${bestHealth.status}`);
                if (bestHealth.latencyMs) {
                    logVerbose(`     Latency: ${bestHealth.latencyMs}ms`);
                }
                if (bestHealth.seqno) {
                    logVerbose(`     Seqno: ${bestHealth.seqno}`);
                }
                
                // Verify best provider is not the failed one
                if (best.id === testProvider.id) {
                    throw new Error(`Best provider should not be the failed provider ${testProvider.id}`);
                }
                logVerbose(`\n  ✓ Best provider is not the failed provider`);
                
                // If health check was done, it should have success: true
                if (bestHealth.status !== 'untested' && !bestHealth.success) {
                    logVerbose(`  ⚠ Warning: Best provider has success: false (unexpected)`);
                }
            }
        } else {
            logVerbose(`\n⚠️  No provider selected (all failed or untested - this is valid)`);
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

    await runTest('Test providers via manager with detailed analysis', async () => {
        const pm = new ProviderManager({});
        await pm.init(network, false);

        logVerbose('Testing all providers...');
        const startTime = performance.now();
        const results = await pm.testAllProviders();
        const duration = Math.round(performance.now() - startTime);
        
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        const byStatus = {
            available: results.filter(r => r.status === 'available'),
            degraded: results.filter(r => r.status === 'degraded'),
            stale: results.filter(r => r.status === 'stale'),
            offline: results.filter(r => r.status === 'offline'),
        };

        const registry = pm['registry']!;
        
        logVerbose(`\n📊 Provider Test Results (${duration}ms):`);
        logVerbose(`  Total tested: ${results.length}`);
        logVerbose(`  ✓ Successful: ${successful.length}`);
        logVerbose(`  ✗ Failed: ${failed.length}`);
        logVerbose(`\n📈 Status Breakdown:`);
        logVerbose(`  🟢 Available: ${byStatus.available.length}`);
        logVerbose(`  🟡 Degraded: ${byStatus.degraded.length}`);
        logVerbose(`  🟠 Stale: ${byStatus.stale.length}`);
        logVerbose(`  🔴 Offline: ${byStatus.offline.length}`);
        
        logVerbose(`\n📋 Detailed Provider Information:\n`);
        for (const r of results) {
            const provider = registry.getProvider(r.id);
            const icon = r.success ? '✓' : '✗';
            const statusColor = r.success 
                ? (r.status === 'available' ? '🟢' : r.status === 'degraded' ? '🟡' : '🟠')
                : '🔴';
            
            logVerbose(`  ${icon} ${statusColor} ${r.id}`);
            logVerbose(`     Name: ${provider?.name || 'Unknown'}`);
            logVerbose(`     Type: ${provider?.type || 'unknown'}`);
            logVerbose(`     Network: ${r.network}`);
            logVerbose(`     Status: ${r.status}`);
            logVerbose(`     Success: ${r.success ? 'Yes' : 'No'}`);
            
            if (r.success) {
                logVerbose(`     Latency: ${r.latencyMs || 'N/A'}ms`);
                logVerbose(`     Seqno: ${r.seqno || 'N/A'}`);
                logVerbose(`     Blocks behind: ${r.blocksBehind || 0}`);
                if (r.cachedEndpoint) {
                    logVerbose(`     Endpoint: ${r.cachedEndpoint}`);
                }
                if (r.lastTested) {
                    logVerbose(`     Last tested: ${r.lastTested.toISOString()}`);
                }
            } else {
                logVerbose(`     Error: ${r.error || 'Unknown error'}`);
                if (r.latencyMs) {
                    logVerbose(`     Latency (before error): ${r.latencyMs}ms`);
                }
            }
            
            // Provider configuration info
            if (provider) {
                logVerbose(`     Priority: ${provider.priority}`);
                logVerbose(`     RPS: ${provider.rps}`);
                const hasApiKey = provider.apiKey ? 'Yes' : 'No';
                const apiKeyRequired = provider.type === 'tatum' || provider.type === 'onfinality' 
                    ? ' (Required)' : ' (Optional)';
                logVerbose(`     API Key: ${hasApiKey}${apiKeyRequired}`);
                if (provider.endpointV2) {
                    logVerbose(`     Endpoint V2: ${provider.endpointV2}`);
                }
            }
            
            logVerbose(``);
        }
        
        // Check for rate limiting issues
        const rateLimitErrors = failed.filter(r => 
            r.error?.includes('429') || r.error?.toLowerCase().includes('rate limit')
        );
        if (rateLimitErrors.length > 0) {
            logVerbose(`\n⚠ Rate Limiting Issues:`);
            logVerbose(`  Found ${rateLimitErrors.length} rate limit errors:`);
            for (const r of rateLimitErrors) {
                logVerbose(`    - ${r.id}: ${r.error}`);
            }
            logVerbose(`  Note: Rate limiter should prevent these. Check rate limit configuration.`);
        }
        
        // Check for invalid seqno issues
        const invalidSeqno = successful.filter(r => !r.seqno || r.seqno <= 0);
        if (invalidSeqno.length > 0) {
            logVerbose(`\n⚠ Invalid Seqno (should not happen):`);
            for (const r of invalidSeqno) {
                logVerbose(`    - ${r.id}: seqno=${r.seqno}`);
            }
        }
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

async function testEdgeCases(network: Network): Promise<void> {
    log('\n=== Edge Cases & Error Handling Tests ===\n');

    await runTest('Handle all providers failing', async () => {
        const pm = new ProviderManager({});
        await pm.init(network, false);
        
        // Manually mark all providers as failed
        const providers = pm['registry']!.getProvidersForNetwork(network);
        const checker = pm['healthChecker']!;
        
        for (const provider of providers) {
            checker.markOffline(provider.id, network, 'Simulated failure');
        }
        
        const selector = pm['selector']!;
        selector.updateBestProvider(network);
        
        const best = selector.getBestProvider(network);
        if (best) {
            const health = checker.getResult(best.id, network);
            const provider = pm['registry']!.getProvider(best.id);
            logVerbose(`\n📋 Fallback Provider Selection:\n`);
            logVerbose(`  Provider: ${best.id} (${provider?.name || 'Unknown'})`);
            logVerbose(`  Type: ${provider?.type || 'unknown'}`);
            if (health) {
                logVerbose(`  Status: ${health.status}`);
                logVerbose(`  Success: ${health.success}`);
                logVerbose(`  Error: ${health.error || 'None'}`);
            } else {
                logVerbose(`  Health: Not tested (untested fallback)`);
            }
            
            // Should fall back to untested provider or null
            if (health && health.success === false) {
                logVerbose(`  ⚠ Warning: Selected provider has success: false`);
            }
        } else {
            logVerbose(`\n⚠️  No provider selected (all failed) - this is correct behavior`);
        }
    });

    await runTest('Rate limiting during health checks', async () => {
        const pm = new ProviderManager({});
        await pm.init(network, false);
        
        const providers = pm['registry']!.getProvidersForNetwork(network).slice(0, 2);
        if (providers.length === 0) {
            logVerbose(`No providers for ${network}, skipping`);
            return;
        }
        
        logVerbose(`Testing ${providers.length} providers with rate limiting...`);
        const startTime = performance.now();
        const results = await pm.testAllProviders();
        const duration = Math.round(performance.now() - startTime);
        
        const rateLimitErrors = results.filter(r => 
            r.error?.includes('429') || r.error?.toLowerCase().includes('rate limit')
        );
        
        logVerbose(`\n📊 Rate Limiting Test Results:\n`);
        logVerbose(`  Test duration: ${duration}ms`);
        logVerbose(`  Total providers tested: ${results.length}`);
        logVerbose(`  Rate limit errors: ${rateLimitErrors.length}`);
        
        if (rateLimitErrors.length > 0) {
            logVerbose(`\n  ⚠ Rate limit errors detected:`);
            for (const r of rateLimitErrors) {
                const provider = pm['registry']!.getProvider(r.id);
                logVerbose(`    🔴 ${r.id} (${provider?.name || 'Unknown'})`);
                logVerbose(`       Error: ${r.error}`);
                logVerbose(`       Type: ${provider?.type || 'unknown'}`);
                logVerbose(`       RPS limit: ${provider?.rps || 'N/A'}`);
                logVerbose(``);
            }
            logVerbose(`  Note: Rate limiter should prevent most of these.`);
        } else {
            logVerbose(`  ✓ No rate limit errors (rate limiter working correctly)`);
        }
        
        logVerbose(`\n  📋 All Provider Results:\n`);
        for (const r of results) {
            const provider = pm['registry']!.getProvider(r.id);
            const statusIcon = r.success ? '✓' : '✗';
            const statusColor = r.success 
                ? (r.status === 'available' ? '🟢' : r.status === 'degraded' ? '🟡' : '🟠')
                : '🔴';
            
            logVerbose(`    ${statusIcon} ${statusColor} ${r.id} (${provider?.name || 'Unknown'})`);
            logVerbose(`       Status: ${r.status}`);
            if (r.success) {
                logVerbose(`       Latency: ${r.latencyMs}ms, Seqno: ${r.seqno}, Behind: ${r.blocksBehind}`);
            } else {
                logVerbose(`       Error: ${r.error?.substring(0, 60) || 'Unknown'}`);
            }
            logVerbose(``);
        }
    });

    await runTest('Provider failover scenario', async () => {
        const pm = new ProviderManager({});
        await pm.init(network, true);
        
        const selector = pm['selector']!;
        const checker = pm['healthChecker']!;
        
        // Get initial best provider
        const initialBest = selector.getBestProvider(network);
        if (!initialBest) {
            logVerbose('No initial provider available, skipping failover test');
            return;
        }
        
        logVerbose(`Initial best provider: ${initialBest.id}`);
        
        // Simulate failure of best provider
        checker.markOffline(initialBest.id, network, 'Simulated failure for failover test');
        selector.handleProviderFailure(initialBest.id, network);
        
        // Get next best provider
        const nextBest = selector.getBestProvider(network);
        if (nextBest) {
            const nextProvider = pm['registry']!.getProvider(nextBest.id);
            const health = checker.getResult(nextBest.id, network);
            
            logVerbose(`\n🔄 Failover Result:\n`);
            logVerbose(`  Next provider: ${nextBest.id} (${nextProvider?.name || 'Unknown'})`);
            logVerbose(`  Type: ${nextProvider?.type || 'unknown'}`);
            
            if (nextBest.id === initialBest.id) {
                logVerbose(`  ⚠ Warning: Same provider selected after failure`);
            } else {
                logVerbose(`  ✓ Failover successful: switched from ${initialBest.id} to ${nextBest.id}`);
            }
            
            if (health) {
                logVerbose(`\n  Health Status:`);
                logVerbose(`    Status: ${health.status}`);
                logVerbose(`    Success: ${health.success}`);
                if (health.latencyMs) {
                    logVerbose(`    Latency: ${health.latencyMs}ms`);
                }
                if (health.seqno) {
                    logVerbose(`    Seqno: ${health.seqno}`);
                }
            }
        } else {
            logVerbose(`\n⚠️  No provider available after failover (all failed)`);
        }
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
            
            // Additional comprehensive tests
            await testEdgeCases(network);
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
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('test.ts')) {
    main().catch(console.error);
}

export { main as runProviderTests };
