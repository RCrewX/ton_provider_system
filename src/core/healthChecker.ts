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
import { createProvider } from '../providers';
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
            browserCompatible: provider.browserCompatible,
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

            // Create provider-specific implementation
            const providerImpl = createProvider(provider);

            // Validate provider configuration
            const validation = providerImpl.validateConfig();
            if (!validation.valid) {
                throw new Error(validation.error || 'Provider configuration invalid');
            }

            // Normalize endpoint using provider-specific implementation
            const normalizedEndpoint = providerImpl.normalizeEndpoint(endpoint);
            
            // Debug logging for OnFinality
            if (provider.type === 'onfinality') {
                this.logger.debug(`OnFinality endpoint: ${endpoint} -> ${normalizedEndpoint}, API key: ${provider.apiKey ? 'set' : 'not set'}`);
            }

            // Call getMasterchainInfo with provider-specific handling
            // For OnFinality, if /rpc fails, it will automatically retry with /public
            let info: MasterchainInfo;
            try {
                info = await this.callGetMasterchainInfo(normalizedEndpoint, provider, providerImpl);
            } catch (error: any) {
                // If OnFinality /rpc fails with backend error and we have an API key, try /public
                if (
                    provider.type === 'onfinality' &&
                    normalizedEndpoint.includes('/rpc') &&
                    provider.apiKey &&
                    error.message?.includes('backend error')
                ) {
                    this.logger.debug(`OnFinality /rpc failed, retrying with /public endpoint`);
                    // Remove query params (including apikey) for /public endpoint
                    const baseUrl = normalizedEndpoint.split('?')[0];
                    const publicEndpoint = baseUrl.replace('/rpc', '/public');
                    const publicProvider = { ...provider, apiKey: undefined };
                    const publicProviderImpl = createProvider(publicProvider);
                    info = await this.callGetMasterchainInfo(publicEndpoint, publicProvider, publicProviderImpl);
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
                browserCompatible: provider.browserCompatible,
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
            const errorMsgLower = errorMsg.toLowerCase();

            // Detect CORS errors (browser compatibility issue)
            const isCorsError = this.isCorsError(error, errorMsg);

            // Detect specific HTTP status codes (check both message and response object)
            // Check error object properties first (more reliable)
            const responseStatus = (error as any)?.response?.status || 
                                  (error as any)?.status || 
                                  (error as any)?.statusCode ||
                                  null;
            
            // Extract status code from error message as fallback
            const statusMatch = errorMsg.match(/\b(\d{3})\b/);
            const statusFromMsg = statusMatch ? parseInt(statusMatch[1], 10) : null;
            const httpStatus = responseStatus || statusFromMsg;

            // Determine error types using both status code and message
            const is429 = httpStatus === 429 || 
                        errorMsgLower.includes('429') || 
                        errorMsgLower.includes('rate limit') ||
                        errorMsgLower.includes('too many requests');
            const is404 = httpStatus === 404 || 
                         errorMsgLower.includes('404') || 
                         errorMsgLower.includes('not found');
            const is401 = httpStatus === 401 || 
                         errorMsgLower.includes('401') || 
                         errorMsgLower.includes('unauthorized') ||
                         errorMsgLower.includes('invalid api key') ||
                         errorMsgLower.includes('authentication failed');
            const is403 = httpStatus === 403 || 
                         errorMsgLower.includes('403') || 
                         errorMsgLower.includes('forbidden');
            const is503 = httpStatus === 503 || 
                         errorMsgLower.includes('503') || 
                         errorMsgLower.includes('service unavailable');
            const is502 = httpStatus === 502 || 
                         errorMsgLower.includes('502') || 
                         errorMsgLower.includes('bad gateway');
            const isTimeout = error.name === 'AbortError' || 
                             errorMsgLower.includes('timeout') ||
                             errorMsgLower.includes('timed out') ||
                             errorMsgLower.includes('aborted');
            
            // Detect OnFinality backend errors
            const isOnFinalityBackendError = provider.type === 'onfinality' && 
                (errorMsgLower.includes('backend error') || errorMsgLower.includes('backend error'));

            // Determine status based on error type
            let status: ProviderStatus = 'offline';
            if (is429) {
                status = 'degraded'; // Rate limit - degraded but might recover
            } else if (is404 || is401 || is403) {
                status = 'offline'; // Permanent errors - endpoint doesn't exist or auth failed
            } else if (is503 || is502 || isOnFinalityBackendError) {
                status = 'offline'; // Service unavailable or backend errors - temporary but severe
            } else if (isTimeout) {
                status = 'offline'; // Timeout - network issue
            }

            // Browser compatibility: if CORS error detected, mark as incompatible
            // Otherwise, use provider's configured browserCompatible flag
            const browserCompatible = isCorsError ? false : provider.browserCompatible;

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
                browserCompatible,
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
     *                       If not provided, calculates delay based on lowest RPS in batch
     */
    async testProviders(
        providers: ResolvedProvider[],
        batchSize: number = 2,
        batchDelayMs?: number
    ): Promise<ProviderHealthResult[]> {
        const results: ProviderHealthResult[] = [];

        for (let i = 0; i < providers.length; i += batchSize) {
            const batch = providers.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map((p) => this.testProvider(p))
            );
            results.push(...batchResults);

            // Add delay between batches (except for last batch)
            if (i + batchSize < providers.length) {
                // Calculate delay based on lowest RPS in current batch if not provided
                let delay = batchDelayMs;
                if (delay === undefined) {
                    // Find minimum RPS in batch
                    const minRps = Math.min(...batch.map(p => p.rps || 1));
                    // Use 1.5x the minimum delay for safety (e.g., 3 RPS = 334ms, use 500ms)
                    delay = Math.max(500, Math.ceil((1000 / minRps) * 1.5));
                }
                
                if (delay > 0) {
                    await this.sleep(delay);
                }
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
     * 
     * Providers marked as degraded have failed health checks (e.g., rate limit errors)
     * and should not be selected. The system will failover to the next available provider.
     */
    markDegraded(providerId: string, network: Network, error?: string): void {
        const key = this.getResultKey(providerId, network);
        const existing = this.results.get(key);

        // Degraded providers have failed (e.g., 429 rate limit errors)
        // They should have success: false so they are not selected and system fails over
        const result: ProviderHealthResult = existing ? {
            ...existing,
            success: false, // Degraded providers with errors should not be selected
            status: 'degraded',
            error: error || 'Marked as degraded',
            lastTested: new Date(),
            browserCompatible: existing.browserCompatible ?? true,
        } : {
            id: providerId,
            network,
            success: false, // Degraded providers with errors should not be selected
            status: 'degraded',
            latencyMs: null,
            seqno: null,
            blocksBehind: 0,
            lastTested: new Date(),
            error: error || 'Marked as degraded',
            browserCompatible: true, // Default to compatible if unknown
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
            browserCompatible: existing.browserCompatible ?? true,
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
            browserCompatible: true, // Default to compatible if unknown
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
     * Call getMasterchainInfo API with provider-specific handling
     */
    private async callGetMasterchainInfo(
        endpoint: string,
        provider: ResolvedProvider,
        providerImpl: ReturnType<typeof createProvider>
    ): Promise<MasterchainInfo> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

        // Build headers using provider-specific implementation
        const headers = providerImpl.buildHeaders();

        // Build request using provider-specific implementation
        const requestBody = providerImpl.buildRequest('getMasterchainInfo', {});

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
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

            // Parse response using provider-specific implementation
            const info = providerImpl.parseMasterchainInfo(data);

            return info;
        } catch (error: any) {
            clearTimeout(timeoutId);
            throw error;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Detect CORS errors (browser compatibility issues)
     * 
     * CORS errors occur when:
     * - Request header field is not allowed by Access-Control-Allow-Headers
     * - Specifically, x-ton-client-version header is blocked by some providers
     * - Error message contains "CORS", "Access-Control", or "x-ton-client-version"
     */
    private isCorsError(error: any, errorMsg: string): boolean {
        const msg = errorMsg.toLowerCase();
        
        // Check for CORS-related error messages
        if (
            msg.includes('cors') ||
            msg.includes('access-control') ||
            msg.includes('x-ton-client-version') ||
            msg.includes('not allowed by access-control-allow-headers') ||
            msg.includes('blocked by cors policy')
        ) {
            return true;
        }

        // Check for network errors that might be CORS-related
        // (CORS errors often manifest as generic network errors in browsers)
        if (
            error.name === 'TypeError' &&
            (msg.includes('failed to fetch') || msg.includes('network error'))
        ) {
            // Additional check: if this is in a browser environment and the error
            // is a network error, it might be CORS (but we can't be 100% sure)
            // We'll be conservative and only mark as CORS if explicitly mentioned
            return false; // Don't assume network errors are CORS
        }

        return false;
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
