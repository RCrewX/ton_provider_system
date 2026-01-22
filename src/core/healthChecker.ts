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
import type { RateLimiterManager } from './rateLimiter';

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
    private rateLimiter: RateLimiterManager | null = null;

    constructor(
        config?: Partial<HealthCheckConfig>,
        logger?: Logger,
        rateLimiter?: RateLimiterManager
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.logger = logger || consoleLogger;
        this.rateLimiter = rateLimiter || null;
    }

    /**
     * Set rate limiter (can be set after construction)
     */
    setRateLimiter(rateLimiter: RateLimiterManager | null): void {
        this.rateLimiter = rateLimiter;
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
            // Acquire rate limit token if rate limiter is available
            if (this.rateLimiter) {
                const acquired = await this.rateLimiter.acquire(provider.id, this.config.timeoutMs);
                if (!acquired) {
                    throw new Error('Rate limit timeout - unable to acquire token for health check');
                }
            }

            // Get endpoint URL
            const endpoint = await this.getEndpoint(provider);
            if (!endpoint) {
                throw new Error('No valid endpoint available');
            }

            // Check for required API keys
            if (provider.type === 'tatum' && !provider.apiKey) {
                throw new Error('Tatum provider requires API key (set TATUM_API_KEY_TESTNET or TATUM_API_KEY_MAINNET)');
            }

            // Normalize endpoint for v2 API (provider-specific handling)
            let normalizedEndpoint = this.normalizeEndpointForProvider(provider, endpoint);
            
            // Debug logging for OnFinality
            if (provider.type === 'onfinality') {
                this.logger.debug(`OnFinality endpoint: ${endpoint} -> ${normalizedEndpoint}, API key: ${provider.apiKey ? 'set' : 'not set'}`);
            }

            // Call getMasterchainInfo with provider-specific handling
            // For OnFinality, if /rpc fails, it will automatically retry with /public
            let info: MasterchainInfo;
            try {
                info = await this.callGetMasterchainInfo(normalizedEndpoint, provider);
            } catch (error: any) {
                // If OnFinality /rpc fails with backend error and we have an API key, try /public
                if (
                    provider.type === 'onfinality' &&
                    normalizedEndpoint.includes('/rpc') &&
                    provider.apiKey &&
                    error.message?.includes('backend error')
                ) {
                    this.logger.debug(`OnFinality /rpc failed, retrying with /public endpoint`);
                    const publicEndpoint = normalizedEndpoint.replace('/rpc', '/public');
                    info = await this.callGetMasterchainInfo(publicEndpoint, { ...provider, apiKey: undefined });
                } else {
                    throw error;
                }
            }

            const endTime = performance.now();
            const latencyMs = Math.round(endTime - startTime);

            // Extract seqno - validate it's a valid block number
            const infoWithLast = info as { last?: { seqno?: number } };
            const seqno = infoWithLast.last?.seqno;
            
            // seqno must be a positive integer (blocks start from 1)
            // seqno=0 or undefined means invalid/malformed response
            if (!seqno || seqno <= 0 || !Number.isInteger(seqno)) {
                throw new Error('Invalid seqno in response (must be positive integer)');
            }

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
            const is503 = errorMsg.includes('503') || errorMsg.toLowerCase().includes('service unavailable');
            const is502 = errorMsg.includes('502') || errorMsg.toLowerCase().includes('bad gateway');
            const isTimeout = error.name === 'AbortError' || errorMsg.includes('timeout');
            
            // Detect OnFinality backend errors
            const isOnFinalityBackendError = provider.type === 'onfinality' && 
                (errorMsg.includes('Backend error') || errorMsg.includes('backend error'));

            // Determine status based on error type
            let status: ProviderStatus = 'offline';
            if (is429) {
                status = 'degraded';
            } else if (is404 || is503 || is502 || isOnFinalityBackendError) {
                status = 'offline'; // Service unavailable or backend errors
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
     * 
     * @param batchSize - Number of providers to test in parallel (default: 2)
     * @param batchDelayMs - Delay between batches in milliseconds (default: 500 to avoid rate limits)
     */
    async testProviders(
        providers: ResolvedProvider[],
        batchSize: number = 2,
        batchDelayMs: number = 500
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

        const result: ProviderHealthResult = existing ? {
            ...existing,
            status: 'degraded',
            error: error || 'Marked as degraded',
            lastTested: new Date(),
        } : {
            id: providerId,
            network,
            success: false,
            status: 'degraded',
            latencyMs: null,
            seqno: null,
            blocksBehind: 0,
            lastTested: new Date(),
            error: error || 'Marked as degraded',
        };

        this.results.set(key, result);
    }

    /**
     * Mark a provider as offline
     */
    markOffline(providerId: string, network: Network, error?: string): void {
        const key = this.getResultKey(providerId, network);
        const existing = this.results.get(key);

        const result: ProviderHealthResult = existing ? {
            ...existing,
            status: 'offline',
            success: false, // Ensure success is false for offline providers
            error: error || 'Marked as offline',
            lastTested: new Date(),
        } : {
            id: providerId,
            network,
            success: false,
            status: 'offline',
            latencyMs: null,
            seqno: null,
            blocksBehind: 0,
            lastTested: new Date(),
            error: error || 'Marked as offline',
        };

        this.results.set(key, result);
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
     * Normalize endpoint for provider-specific requirements
     * 
     * Note: normalizeV2Endpoint now handles all provider-specific cases correctly,
     * including Tatum (/jsonRPC), OnFinality (/public or /rpc), QuickNode, and GetBlock.
     */
    private normalizeEndpointForProvider(provider: ResolvedProvider, endpoint: string): string {
        // Handle legacy Tatum API format conversion (if needed)
        if (provider.type === 'tatum' && endpoint.includes('api.tatum.io/v3/blockchain/node')) {
            const network = provider.network === 'testnet' ? 'testnet' : 'mainnet';
            endpoint = `https://ton-${network}.gateway.tatum.io`;
        }
        
        // Use the unified normalization function which handles all providers correctly
        return normalizeV2Endpoint(endpoint);
    }

    /**
     * Call getMasterchainInfo API with provider-specific handling
     */
    private async callGetMasterchainInfo(
        endpoint: string,
        provider: ResolvedProvider
    ): Promise<MasterchainInfo> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

        // Build headers with provider-specific API key handling
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        // Tatum requires API key in x-api-key header
        if (provider.type === 'tatum' && provider.apiKey) {
            headers['x-api-key'] = provider.apiKey;
        }

        // OnFinality supports API key in header (preferred) or query params
        // Use header method to avoid query string issues
        if (provider.type === 'onfinality' && provider.apiKey) {
            headers['apikey'] = provider.apiKey;
        }

        // Other providers (TonCenter, Chainstack) use apiKey in TonClient, not in health check

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    id: '1',
                    jsonrpc: '2.0',
                    method: 'getMasterchainInfo',
                    params: {},
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            // Check content type before parsing
            const contentType = response.headers.get('content-type') || '';
            let text: string | null = null;
            let data: unknown;

            // Read response as text first to check for errors
            if (!contentType.includes('application/json')) {
                text = await response.text();
                
                // For non-JSON responses, throw error (fallback will be handled at higher level)
                this.logger.debug(`${provider.type} non-JSON response (${contentType}): ${text.substring(0, 200)}`);
                
                // Special error message for OnFinality backend errors
                if (provider.type === 'onfinality' && text.includes('Backend error')) {
                    throw new Error(`OnFinality backend error: ${text}`);
                }
                
                throw new Error(`Invalid response type: expected JSON, got ${contentType}. Response: ${text.substring(0, 100)}`);
            }

            // Parse JSON response
            if (!response.ok) {
                // Try to parse error response as JSON first
                try {
                    data = await response.json();
                    const errorObj = data as { error?: { message?: string; code?: number } | string };
                    const errorMsg = typeof errorObj.error === 'string' 
                        ? errorObj.error 
                        : errorObj.error?.message || `HTTP ${response.status}`;
                    throw new Error(errorMsg);
                } catch {
                    throw new Error(`HTTP ${response.status}`);
                }
            }

            data = await response.json();

            let info: MasterchainInfo;

            // Handle different response formats
            if (data && typeof data === 'object') {
                const dataObj = data as Record<string, unknown>;
                
                // Handle wrapped response { ok: true, result: ... } (GetBlock, some providers)
                if ('ok' in dataObj) {
                    if (!dataObj.ok) {
                        const error = (dataObj as { error?: string }).error;
                        throw new Error(error || 'API returned ok=false');
                    }
                    const result = (dataObj as { result?: unknown }).result;
                    info = (result || dataObj) as MasterchainInfo;
                }
                // Handle JSON-RPC response { result: ... } (standard JSON-RPC)
                else if ('result' in dataObj) {
                    info = (dataObj as { result: unknown }).result as MasterchainInfo;
                }
                // Handle direct response (some providers return data directly)
                else if ('last' in dataObj || '@type' in dataObj) {
                    info = dataObj as unknown as MasterchainInfo;
                }
                // Handle error response { error: ... }
                else if ('error' in dataObj) {
                    const errorObj = dataObj.error as { message?: string; code?: string } | string;
                    const errorMsg = typeof errorObj === 'string' 
                        ? errorObj 
                        : errorObj?.message || errorObj?.code || String(errorObj);
                    throw new Error(`API error: ${errorMsg}`);
                }
                // Unknown format
                else {
                    throw new Error(`Unknown response format from ${provider.type}`);
                }
            } else {
                throw new Error(`Invalid response type: ${typeof data}`);
            }

            // Validate response structure
            if (!info || typeof info !== 'object') {
                // Log the actual response for debugging
                this.logger.debug(`Invalid response structure from ${provider.type}: ${JSON.stringify(data)}`);
                throw new Error('Invalid response structure');
            }

            // Validate seqno exists and is valid (blocks start from 1)
            const infoObj = info as { last?: { seqno?: number } };
            const seqno = infoObj.last?.seqno;
            if (seqno === undefined || seqno === null || seqno <= 0 || !Number.isInteger(seqno)) {
                // Log the actual response for debugging
                this.logger.debug(`Invalid seqno from ${provider.type}:`, { seqno, info });
                throw new Error(`Invalid seqno: ${seqno} (must be positive integer)`);
            }

            return info;
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
    logger?: Logger,
    rateLimiter?: RateLimiterManager
): HealthChecker {
    return new HealthChecker(config, logger, rateLimiter);
}
