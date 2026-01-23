#!/usr/bin/env ts-node
/**
 * Browser Compatibility Test Script
 *
 * Tests provider system in a browser-like environment using TonClient.
 * Simulates the ton_site workflow to verify browser compatibility.
 *
 * Usage:
 *   pnpm browser-test
 *   ts-node scripts/browser-test.ts
 *
 * Options:
 *   --network testnet|mainnet   Network to test (default: testnet)
 *   --verbose                   Show detailed output
 */

import * as dotenv from 'dotenv';
import { Address, TonClient } from '@ton/ton';

// Load environment variables first
dotenv.config();

import {
    ProviderManager,
    normalizeV2Endpoint,
} from '../src/index';

// ============================================================================
// Test Configuration
// ============================================================================

interface TestResult {
    providerId: string;
    providerName: string;
    endpoint: string;
    browserCompatible: boolean;
    success: boolean;
    error?: string;
    latencyMs?: number;
}

// ============================================================================
// Test Functions
// ============================================================================

/**
 * Test a provider using TonClient (simulates browser usage)
 */
async function testProviderWithTonClient(
    providerId: string,
    providerName: string,
    endpoint: string,
    network: 'testnet' | 'mainnet'
): Promise<TestResult> {
    const startTime = Date.now();
    const normalizedEndpoint = normalizeV2Endpoint(endpoint);

    try {
        // Create TonClient with the endpoint (like ton_site does)
        const client = new TonClient({
            endpoint: normalizedEndpoint,
            apiKey: undefined, // No API key for public endpoints
        });

        // Test 1: getMasterchainInfo (basic connectivity)
        const masterchainInfo = await client.getMasterchainInfo();
        // Check if response is valid (can have different structures)
        if (!masterchainInfo) {
            throw new Error('Invalid masterchainInfo response: null or undefined');
        }
        // Some providers return different structures, so just check if we got something
        if (typeof masterchainInfo !== 'object') {
            throw new Error(`Invalid masterchainInfo response: expected object, got ${typeof masterchainInfo}`);
        }

        // Test 2: getContractState (more complex call, simulates ton_site usage)
        // Use a known valid address (GameManager from ton_game deployment)
        const testAddress = network === 'testnet'
            ? Address.parse('EQC9EbQRbDzocSKipnb62HpupcLuEeZblNA6n6mD0KOSacas')
            : Address.parse('EQC9EbQRbDzocSKipnb62HpupcLuEeZblNA6n6mD0KOSacas');
        
        // Use provider.getState() like ton_site does
        const provider = client.provider(testAddress);
        const state = await provider.getState();
        // State can be null for uninitialized addresses, which is valid
        if (state === undefined) {
            throw new Error('Invalid state response: undefined');
        }

        const latencyMs = Date.now() - startTime;

        return {
            providerId,
            providerName,
            endpoint: normalizedEndpoint,
            browserCompatible: true,
            success: true,
            latencyMs,
        };
    } catch (error: any) {
        const latencyMs = Date.now() - startTime;
        const errorMsg = error.message || String(error) || 'Unknown error';
        
        // Detect CORS errors (browser-specific)
        // Note: This test runs in Node.js, so real CORS errors won't occur.
        // CORS is a browser security feature. However, we can detect CORS-related error messages
        // that might be logged or returned by some providers.
        const isCorsError = 
            errorMsg.toLowerCase().includes('cors') ||
            errorMsg.toLowerCase().includes('access-control') ||
            errorMsg.toLowerCase().includes('x-ton-client-version') ||
            errorMsg.toLowerCase().includes('not allowed by access-control-allow-headers') ||
            errorMsg.toLowerCase().includes('blocked by cors policy') ||
            errorMsg.toLowerCase().includes('preflight') ||
            (error.name === 'TypeError' && 
             errorMsg.toLowerCase().includes('failed to fetch') &&
             !errorMsg.toLowerCase().includes('enotfound') && // DNS errors are not CORS
             !errorMsg.toLowerCase().includes('econnrefused')); // Connection refused is not CORS
        
        // Network/DNS errors are NOT browser incompatibility issues
        // They indicate infrastructure problems, not CORS restrictions
        const isNetworkError = 
            errorMsg.toLowerCase().includes('enotfound') ||
            errorMsg.toLowerCase().includes('econnrefused') ||
            errorMsg.toLowerCase().includes('getaddrinfo') ||
            errorMsg.toLowerCase().includes('dns') ||
            errorMsg.toLowerCase().includes('network error') ||
            errorMsg.toLowerCase().includes('timeout');
        
        // Server errors (5xx) are NOT browser incompatibility
        const isServerError = 
            errorMsg.includes('503') ||
            errorMsg.includes('502') ||
            errorMsg.includes('500') ||
            errorMsg.toLowerCase().includes('service unavailable') ||
            errorMsg.toLowerCase().includes('bad gateway') ||
            errorMsg.toLowerCase().includes('backend error');
        
        // Only mark as browser-incompatible if it's actually a CORS error
        // Network/server errors should still be marked as compatible (they work in browsers when servers are up)
        const browserCompatible = !isCorsError;

        return {
            providerId,
            providerName,
            endpoint: normalizedEndpoint,
            browserCompatible: !isCorsError,
            success: false,
            error: errorMsg,
            latencyMs,
        };
    }
}

/**
 * Run browser compatibility tests for all providers
 */
async function runBrowserTests(network: 'testnet' | 'mainnet' = 'testnet', verbose: boolean = false): Promise<void> {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Browser Compatibility Test - ${network.toUpperCase()}`);
    console.log(`${'='.repeat(80)}`);
    console.log(`\n⚠️  NOTE: This test runs in Node.js, so real CORS errors won't be detected.`);
    console.log(`   CORS is a browser security feature. This test verifies providers work with TonClient.`);
    console.log(`   Real CORS testing must be done in an actual browser environment.\n`);

    // Initialize provider manager in browser mode
    const manager = new ProviderManager({ adapter: 'browser' });
    await manager.init(network, true); // Test providers on init

    // Get all providers (already filtered for browser compatibility)
    const providers = manager.getProviders();
    const healthResults = manager.getProviderHealthResults();

    console.log(`Found ${providers.length} browser-compatible provider(s) for ${network}`);
    
    // Debug: show which providers were filtered
    const allProviders = manager.getRegistry()?.getProvidersForNetwork(network) || [];
    const filteredOut = allProviders.filter(p => !providers.some(pp => pp.id === p.id));
    if (filteredOut.length > 0) {
        console.log(`Filtered out ${filteredOut.length} browser-incompatible provider(s):`);
        filteredOut.forEach(p => {
            const health = healthResults.find(h => h.id === p.id);
            const reason = !p.browserCompatible 
                ? 'config flag (browserCompatible: false)' 
                : (health && health.browserCompatible === false ? 'CORS error detected' : 'unknown');
            console.log(`  - ${p.name} (${p.id}): ${reason}`);
        });
    }
    console.log('');

    if (providers.length === 0) {
        console.warn('⚠️  No browser-compatible providers found!');
        return;
    }

    // Test each provider with TonClient
    const results: TestResult[] = [];
    
    for (const provider of providers) {
        const health = healthResults.find((h) => h.id === provider.id);
        
        if (verbose) {
            console.log(`Testing ${provider.name} (${provider.id})...`);
        }

        // Use provider's specific endpoint, not the manager's selected one
        // For dynamic providers (Orbs), get the actual endpoint
        let endpoint = provider.endpointV2;
        if (provider.isDynamic && provider.type === 'orbs') {
            try {
                const { getHttpEndpoint } = await import('@orbs-network/ton-access');
                endpoint = await getHttpEndpoint({ network: provider.network });
                if (verbose) {
                    console.log(`   Orbs endpoint discovered: ${endpoint}`);
                }
            } catch (error: any) {
                // If Orbs discovery fails, test with fallback static endpoint
                // This is a network/infrastructure issue, not browser incompatibility
                console.log(`⚠️  ${provider.name}: Orbs discovery failed, using fallback endpoint`);
                console.log(`   Error: ${error.message}`);
                console.log(`   Note: This is a network/infrastructure issue, not browser incompatibility`);
                // Use the static endpoint from config as fallback
                endpoint = provider.endpointV2;
            }
        }

        const result = await testProviderWithTonClient(
            provider.id,
            provider.name,
            endpoint,
            network
        );

        results.push(result);

        // Display result
        if (result.success) {
            console.log(`✅ ${provider.name}: SUCCESS (${result.latencyMs}ms)`);
        } else {
            // Categorize the error type
            const errorMsg = result.error?.toLowerCase() || '';
            let errorType = 'UNKNOWN';
            if (errorMsg.includes('cors') || errorMsg.includes('access-control')) {
                errorType = 'CORS (Browser Incompatible)';
            } else if (errorMsg.includes('enotfound') || errorMsg.includes('getaddrinfo') || errorMsg.includes('dns')) {
                errorType = 'Network/DNS Error';
            } else if (errorMsg.includes('503') || errorMsg.includes('502') || errorMsg.includes('service unavailable')) {
                errorType = 'Server Error (5xx)';
            } else {
                errorType = 'Other Error';
            }
            
            const compatStatus = result.browserCompatible ? 'COMPATIBLE' : 'INCOMPATIBLE (CORS)';
            console.log(`❌ ${provider.name}: FAILED - ${compatStatus} [${errorType}]`);
            if (verbose || !result.browserCompatible) {
                console.log(`   Error: ${result.error}`);
            }
        }
    }

    // Summary
    console.log(`\n${'='.repeat(80)}`);
    console.log('Summary');
    console.log(`${'='.repeat(80)}`);

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    const incompatible = results.filter((r) => !r.browserCompatible);

    console.log(`Total providers tested: ${results.length}`);
    console.log(`✅ Successful: ${successful.length}`);
    console.log(`❌ Failed: ${failed.length}`);
    console.log(`🚫 Browser-incompatible (CORS): ${incompatible.length}`);

    if (successful.length > 0) {
        console.log(`\n✅ Working providers:`);
        successful.forEach((r) => {
            console.log(`   - ${r.providerName} (${r.latencyMs}ms)`);
        });
    }

    if (incompatible.length > 0) {
        console.log(`\n🚫 Browser-incompatible providers (CORS errors):`);
        incompatible.forEach((r) => {
            console.log(`   - ${r.providerName}`);
            if (verbose) {
                console.log(`     Error: ${r.error}`);
            }
        });
    }

    if (failed.length > incompatible.length) {
        console.log(`\n⚠️  Other failures (not CORS):`);
        failed
            .filter((r) => r.browserCompatible)
            .forEach((r) => {
                console.log(`   - ${r.providerName}: ${r.error}`);
            });
    }

    console.log(`\n${'='.repeat(80)}\n`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const network = (args.includes('--network') 
        ? args[args.indexOf('--network') + 1] 
        : 'testnet') as 'testnet' | 'mainnet';
    const verbose = args.includes('--verbose');

    try {
        await runBrowserTests(network, verbose);
        process.exit(0);
    } catch (error: any) {
        console.error(`\n❌ Test failed: ${error.message}`);
        if (verbose) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// Run if executed directly (ES module check)
// Check if this file is being run directly (not imported)
const isMainModule = import.meta.url.endsWith(process.argv[1]) || 
                     import.meta.url.includes(process.argv[1].replace(/\\/g, '/'));
if (isMainModule || process.argv[1]?.includes('browser-test.ts')) {
    main();
}
