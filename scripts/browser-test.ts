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
        if (!masterchainInfo || !masterchainInfo.last) {
            throw new Error('Invalid masterchainInfo response');
        }

        // Test 2: getAddressInformation (more complex call)
        // Use a known testnet address
        const testAddress = network === 'testnet'
            ? Address.parse('EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIo')
            : Address.parse('EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIo');
        
        const addressInfo = await client.getAddressInformation(testAddress);
        if (!addressInfo) {
            throw new Error('Invalid addressInfo response');
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
        
        // Detect CORS errors
        const isCorsError = 
            errorMsg.toLowerCase().includes('cors') ||
            errorMsg.toLowerCase().includes('access-control') ||
            errorMsg.toLowerCase().includes('x-ton-client-version') ||
            errorMsg.toLowerCase().includes('not allowed by access-control-allow-headers') ||
            errorMsg.toLowerCase().includes('blocked by cors policy') ||
            (error.name === 'TypeError' && errorMsg.toLowerCase().includes('failed to fetch'));

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
    console.log(`${'='.repeat(80)}\n`);

    // Initialize provider manager in browser mode
    const manager = new ProviderManager({ adapter: 'browser' });
    await manager.init(network, true); // Test providers on init

    // Get all providers (already filtered for browser compatibility)
    const providers = manager.getProviders();
    const healthResults = manager.getProviderHealthResults();

    console.log(`Found ${providers.length} browser-compatible provider(s) for ${network}\n`);

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

        const endpoint = await manager.getEndpoint();
        const result = await testProviderWithTonClient(
            provider.id,
            provider.name,
            provider.endpointV2,
            network
        );

        results.push(result);

        // Display result
        if (result.success) {
            console.log(`✅ ${provider.name}: SUCCESS (${result.latencyMs}ms)`);
        } else {
            const compatStatus = result.browserCompatible ? 'COMPATIBLE' : 'INCOMPATIBLE (CORS)';
            console.log(`❌ ${provider.name}: FAILED - ${compatStatus}`);
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

// Run if executed directly
if (require.main === module) {
    main();
}
