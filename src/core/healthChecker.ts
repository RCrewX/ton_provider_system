/**
 * Unified Provider System - Health Checker
 *
 * Tests provider connectivity, measures latency, and compares block heights.
 * Identifies stale, degraded, or offline providers.
 */

import type {
    ResolvedProvider,
    ProviderHealthResult,
    ProviderStatus,
    Network,
    MasterchainInfo,
    TonApiResponse,
    Logger,
    TimeoutError,
} from '../types';
import { normalizeV2Endpoint } from '../utils/endpoint';

// ============================================================================
// Console Logger (default)
// ============================================================================

const consoleLogger: Logger = {
    debug: (msg, data) => console.debug(`[HealthChecker] ${msg}`, data || ''),
    info: (msg, data) => console.log(`[HealthChecker] ${msg}`, data || ''),
    warn: (msg, data) => console.warn(`[HealthChecker] ${msg}`, data || ''),
    error: (msg, data) => console.error(`[HealthChecker] ${msg}`, data || ''),
};

// ============================================================================
// Health Check Configuration
// ============================================================================

export interface HealthCheckConfig {
    /** Request timeout in milliseconds */
    timeoutMs: number;
    /** Maximum blocks behind before marking as stale */
    maxBlocksBehind: number;
    /** Latency threshold (ms) for degraded status */
    degradedLatencyMs: number;
}

const DEFAULT_CONFIG: HealthCheckConfig = {
    timeoutMs: 10000,
    maxBlocksBehind: 10,
    degradedLatencyMs: 3000,
};

// ============================================================================
// Health Checker Class
// ============================================================================

/**
 * Health Checker
 *
 * Tests provider health by calling getMasterchainInfo and measuring
 * latency and block height.
 */
export class HealthChecker {
    private config: HealthCheckConfig;
    private logger: Logger;
    private results: Map<string, ProviderHealthResult> = new Map();
    private highestSeqno: Map<Network, number> = new Map();

    constructor(config?: Partial<HealthCheckConfig>, logger?: Logger) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.logger = logger || consoleLogger;
    }

    /**
     * Test a single provider's health
     */
    async testProvider(provider: ResolvedProvider): Promise<ProviderHealthResult> {
        const startTime = performance.now();
        const key = this.getResultKey(provider.id, provider.network);

        // Mark as testing
        const testingResult: ProviderHealthResult = {
            id: provider.id,
            network: provider.network,
            success: false,
            status: 'testing',
            latencyMs: null,
            seqno: null,
            blocksBehind: 0,
            lastTested: null,
        };
        this.results.set(key, testingResult);

        try {
            // Get endpoint URL
            const endpoint = await this.getEndpoint(provider);
            if (!endpoint) {
                throw new Error('No valid endpoint available');
            }

            // Normalize endpoint for v2 API
            const normalizedEndpoint = normalizeV2Endpoint(endpoint);

            // Call getMasterchainInfo
            const info = await this.callGetMasterchainInfo(normalizedEndpoint);

            const endTime = performance.now();
            const latencyMs = Math.round(endTime - startTime);

            // Extract seqno
            const seqno = info.last?.seqno || 0;

            // Update highest known seqno for this network
            const currentHighest = this.highestSeqno.get(provider.network) || 0;
            if (seqno > currentHighest) {
                this.highestSeqno.set(provider.network, seqno);
            }

            // Calculate blocks behind
            const blocksBehind = Math.max(0, (this.highestSeqno.get(provider.network) || seqno) - seqno);

            // Determine status
            let status: ProviderStatus = 'available';
            if (blocksBehind > this.config.maxBlocksBehind) {
                status = 'stale';
            } else if (latencyMs > this.config.degradedLatencyMs) {
                status = 'degraded';
            }

            const result: ProviderHealthResult = {
                id: provider.id,
                network: provider.network,
                success: true,
                status,
                latencyMs,
                seqno,
                blocksBehind,
                lastTested: new Date(),
                cachedEndpoint: normalizedEndpoint,
            };

            this.results.set(key, result);
            this.logger.debug(
                `Provider ${provider.id} health check: ${status} (${latencyMs}ms, seqno=${seqno}, behind=${blocksBehind})`
            );

            return result;
        } catch (error: any) {
            const endTime = performance.now();
            const latencyMs = Math.round(endTime - startTime);

            const errorMsg = error.message || String(error) || 'Unknown error';

            // Detect specific HTTP status codes
            const is429 = errorMsg.includes('429') || errorMsg.toLowerCase().includes('rate limit');
            const is404 = errorMsg.includes('404') || errorMsg.toLowerCase().includes('not found');
            const isTimeout = error.name === 'AbortError' || errorMsg.includes('timeout');

            // Determine status based on error type
            let status: ProviderStatus = 'offline';
            if (is429) {
                status = 'degraded';
            } else if (is404) {
                status = 'offline'; // 404 means endpoint doesn't exist
            } else if (isTimeout) {
                status = 'offline';
            }

            const result: ProviderHealthResult = {
                id: provider.id,
                network: provider.network,
                success: false,
                status,
                latencyMs: isTimeout ? null : latencyMs,
                seqno: null,
                blocksBehind: 0,
                lastTested: new Date(),
                error: errorMsg,
            };

            this.results.set(key, result);
            this.logger.warn(`Provider ${provider.id} health check failed: ${result.error}`);

            return result;
        }
    }

    /**
     * Test multiple providers in parallel with staggered batches
     */
    async testProviders(
        providers: ResolvedProvider[],
        batchSize: number = 2,
        batchDelayMs: number = 300
    ): Promise<ProviderHealthResult[]> {
        const results: ProviderHealthResult[] = [];

        for (let i = 0; i < providers.length; i += batchSize) {
            const batch = providers.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map((p) => this.testProvider(p))
            );
            results.push(...batchResults);

            // Add delay between batches (except for last batch)
            if (i + batchSize < providers.length && batchDelayMs > 0) {
                await this.sleep(batchDelayMs);
            }
        }

        return results;
    }

    /**
     * Get the last health result for a provider
     */
    getResult(providerId: string, network: Network): ProviderHealthResult | undefined {
        const key = this.getResultKey(providerId, network);
        return this.results.get(key);
    }

    /**
     * Get all results for a network
     */
    getResultsForNetwork(network: Network): ProviderHealthResult[] {
        const results: ProviderHealthResult[] = [];
        for (const [key, result] of this.results) {
            if (result.network === network) {
                results.push(result);
            }
        }
        return results;
    }

    /**
     * Get available providers for a network (status = available or degraded)
     */
    getAvailableProviders(network: Network): ProviderHealthResult[] {
        return this.getResultsForNetwork(network).filter(
            (r) => r.status === 'available' || r.status === 'degraded'
        );
    }

    /**
     * Get the best provider for a network (lowest latency among available)
     */
    getBestProvider(network: Network): ProviderHealthResult | undefined {
        const available = this.getAvailableProviders(network)
            .filter((r) => r.latencyMs !== null)
            .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));

        return available[0];
    }

    /**
     * Get highest known seqno for a network
     */
    getHighestSeqno(network: Network): number {
        return this.highestSeqno.get(network) || 0;
    }

    /**
     * Clear all results
     */
    clearResults(): void {
        this.results.clear();
        this.highestSeqno.clear();
    }

    /**
     * Mark a provider as degraded (e.g., on 429 error)
     */
    markDegraded(providerId: string, network: Network, error?: string): void {
        const key = this.getResultKey(providerId, network);
        const existing = this.results.get(key);

        if (existing) {
            this.results.set(key, {
                ...existing,
                status: 'degraded',
                error: error || 'Marked as degraded',
                lastTested: new Date(),
            });
        }
    }

    /**
     * Mark a provider as offline
     */
    markOffline(providerId: string, network: Network, error?: string): void {
        const key = this.getResultKey(providerId, network);
        const existing = this.results.get(key);

        if (existing) {
            this.results.set(key, {
                ...existing,
                status: 'offline',
                error: error || 'Marked as offline',
                lastTested: new Date(),
            });
        }
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    private getResultKey(providerId: string, network: Network): string {
        return `${providerId}-${network}`;
    }

    /**
     * Get endpoint URL for a provider (handles dynamic providers like Orbs)
     */
    private async getEndpoint(provider: ResolvedProvider): Promise<string | null> {
        // For dynamic providers (Orbs), use ton-access discovery
        if (provider.isDynamic && provider.type === 'orbs') {
            try {
                const { getHttpEndpoint } = await import('@orbs-network/ton-access');
                const endpoint = await getHttpEndpoint({ network: provider.network });
                return endpoint;
            } catch (error: any) {
                this.logger.warn(`Failed to get Orbs endpoint: ${error.message}`);
                return null;
            }
        }

        // Use static endpoint
        return provider.endpointV2 || provider.endpointV3 || null;
    }

    /**
     * Call getMasterchainInfo API
     */
    private async callGetMasterchainInfo(endpoint: string): Promise<MasterchainInfo> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: '1',
                    jsonrpc: '2.0',
                    method: 'getMasterchainInfo',
                    params: {},
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            // Handle wrapped response { ok: true, result: ... }
            if (data && typeof data === 'object' && 'ok' in data) {
                if (!data.ok) {
                    throw new Error(data.error || 'API returned ok=false');
                }
                return (data.result || data) as MasterchainInfo;
            }

            // Handle JSON-RPC response { result: ... }
            if (data.result) {
                return data.result as MasterchainInfo;
            }

            return data as MasterchainInfo;
        } catch (error: any) {
            clearTimeout(timeoutId);
            throw error;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a health checker with default configuration
 */
export function createHealthChecker(
    config?: Partial<HealthCheckConfig>,
    logger?: Logger
): HealthChecker {
    return new HealthChecker(config, logger);
}
