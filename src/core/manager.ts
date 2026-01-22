/**
 * Unified Provider System - Provider Manager
 *
 * Main entry point for the provider system.
 * Coordinates registry, health checker, rate limiter, and selector.
 */

import type {
    Network,
    ResolvedProvider,
    ProviderHealthResult,
    ProviderManagerOptions,
    ProviderManagerState,
    ProviderState,
    RateLimitConfig,
    Logger,
    StateListener,
} from '../types';
import { loadConfig, mergeWithDefaults, createDefaultConfig } from '../config';
import { ProviderRegistry, createRegistryFromFile } from './registry';
import { HealthChecker, createHealthChecker } from './healthChecker';
import { RateLimiterManager, createRateLimiterManager, getRateLimitForType } from './rateLimiter';
import { ProviderSelector, createSelector } from './selector';
import { normalizeV2Endpoint } from '../utils/endpoint';
import { isRateLimitError } from '../utils/timeout';

// ============================================================================
// Console Logger (default)
// ============================================================================

const consoleLogger: Logger = {
    debug: (msg, data) => console.debug(`[ProviderManager] ${msg}`, data || ''),
    info: (msg, data) => console.log(`[ProviderManager] ${msg}`, data || ''),
    warn: (msg, data) => console.warn(`[ProviderManager] ${msg}`, data || ''),
    error: (msg, data) => console.error(`[ProviderManager] ${msg}`, data || ''),
};

// ============================================================================
// Default Options
// ============================================================================

const DEFAULT_OPTIONS: Required<ProviderManagerOptions> = {
    configPath: '', // Unused - config is loaded from provider_system/rpc.json
    adapter: 'node',
    autoInit: true,
    requestTimeoutMs: 10000,
    healthCheckIntervalMs: 0, // Disabled by default
    maxBlocksBehind: 10,
    logger: consoleLogger,
};

// ============================================================================
// Provider Manager
// ============================================================================

/**
 * Provider Manager
 *
 * Main entry point for the unified provider system.
 * Manages providers, health checks, rate limiting, and selection.
 *
 * Usage:
 * ```typescript
 * // Singleton pattern (Node.js)
 * const pm = ProviderManager.getInstance();
 * await pm.init('testnet');
 * const endpoint = await pm.getEndpoint();
 *
 * // Instance pattern (Browser/React)
 * const pm = new ProviderManager({ adapter: 'browser' });
 * await pm.init(network);
 * ```
 */
export class ProviderManager {
    // Singleton instance
    private static instance: ProviderManager | null = null;

    // Components
    private registry: ProviderRegistry | null = null;
    private healthChecker: HealthChecker | null = null;
    private rateLimiter: RateLimiterManager | null = null;
    private selector: ProviderSelector | null = null;

    // State
    private options: Required<ProviderManagerOptions>;
    private network: Network | null = null;
    private initialized: boolean = false;
    private isTesting: boolean = false;
    private healthCheckInterval: NodeJS.Timeout | null = null;
    private listeners: Set<StateListener> = new Set();

    constructor(options?: ProviderManagerOptions) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    // ========================================================================
    // Singleton Pattern
    // ========================================================================

    /**
     * Get singleton instance (recommended for Node.js)
     */
    static getInstance(options?: ProviderManagerOptions): ProviderManager {
        if (!ProviderManager.instance) {
            ProviderManager.instance = new ProviderManager(options);
        }
        return ProviderManager.instance;
    }

    /**
     * Reset singleton instance (for testing)
     */
    static resetInstance(): void {
        if (ProviderManager.instance) {
            ProviderManager.instance.destroy();
            ProviderManager.instance = null;
        }
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Initialize the provider manager
     *
     * @param network - Network to initialize for
     * @param testProviders - Whether to test providers immediately (default: true)
     */
    async init(network: Network, testProviders: boolean = true): Promise<void> {
        if (this.initialized && this.network === network) {
            this.options.logger.debug('Already initialized for this network');
            return;
        }

        this.options.logger.info(`Initializing for ${network}...`);
        this.network = network;

        // Load configuration from provider_system/rpc.json
        const config = await loadConfig();
        const mergedConfig = mergeWithDefaults(config);

        // Create components
        this.registry = new ProviderRegistry(mergedConfig, this.options.logger);
        this.rateLimiter = createRateLimiterManager(this.options.logger);
        
        // Configure rate limiters for each provider BEFORE creating health checker
        for (const provider of this.registry.getAllProviders()) {
            const config = getRateLimitForType(provider.type);
            // Add buffer to minDelayMs to be more conservative and avoid hitting limits
            // For very low RPS (<=3), use 20% buffer; for others, use 10%
            const bufferMultiplier = provider.rps <= 3 ? 1.2 : 1.1;
            const minDelayMs = Math.ceil((1000 / provider.rps) * bufferMultiplier);
            // Calculate conservative burst size based on RPS:
            // - For very low RPS (<=3): burst size of 1 to be extremely conservative
            // - For low RPS (4-5): burst size of 2
            // - For higher RPS: use 1.5x RPS (standard token bucket pattern)
            let burstSize: number;
            if (provider.rps <= 3) {
                burstSize = 1; // Very conservative for low RPS providers like Tatum
            } else if (provider.rps <= 5) {
                burstSize = 2; // Conservative for low RPS
            } else {
                burstSize = Math.max(3, Math.ceil(provider.rps * 1.5)); // 150% for higher RPS
            }
            
            this.rateLimiter.setConfig(provider.id, {
                ...config,
                rps: provider.rps,
                minDelayMs,
                burstSize,
            });
        }
        
        // Create health checker with rate limiter
        this.healthChecker = createHealthChecker(
            {
                timeoutMs: this.options.requestTimeoutMs,
                maxBlocksBehind: this.options.maxBlocksBehind,
            },
            this.options.logger,
            this.rateLimiter
        );
        
        this.selector = createSelector(
            this.registry,
            this.healthChecker,
            undefined,
            this.options.logger
        );

        this.initialized = true;
        this.notifyListeners();

        // Test providers if requested
        if (testProviders) {
            await this.testAllProviders();
        }

        // Start health check interval if configured
        if (this.options.healthCheckIntervalMs > 0) {
            this.startHealthCheckInterval();
        }

        this.options.logger.info('Initialization complete');
    }

    /**
     * Check if manager is initialized
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Destroy the manager (cleanup)
     */
    destroy(): void {
        this.stopHealthCheckInterval();
        this.listeners.clear();
        this.registry = null;
        this.healthChecker = null;
        this.rateLimiter = null;
        this.selector = null;
        this.initialized = false;
        this.network = null;
    }

    // ========================================================================
    // Provider Testing
    // ========================================================================

    /**
     * Test all providers for current network
     */
    async testAllProviders(): Promise<ProviderHealthResult[]> {
        this.ensureInitialized();

        if (this.isTesting) {
            this.options.logger.debug('Already testing providers');
            return [];
        }

        this.isTesting = true;
        this.notifyListeners();

        this.options.logger.info(`Testing all providers for ${this.network}...`);

        try {
            const providers = this.registry!.getProvidersForNetwork(this.network!);
            const results = await this.healthChecker!.testProviders(providers);

            // Update selector with new best provider
            this.selector!.updateBestProvider(this.network!);

            const available = results.filter((r) => r.success);
            this.options.logger.info(
                `Provider testing complete: ${available.length}/${results.length} available`
            );

            return results;
        } finally {
            this.isTesting = false;
            this.notifyListeners();
        }
    }

    /**
     * Test a specific provider
     */
    async testProvider(providerId: string): Promise<ProviderHealthResult | null> {
        this.ensureInitialized();

        const provider = this.registry!.getProvider(providerId);
        if (!provider) {
            this.options.logger.warn(`Provider ${providerId} not found`);
            return null;
        }

        return this.healthChecker!.testProvider(provider);
    }

    /**
     * Check if testing is in progress
     */
    isTestingProviders(): boolean {
        return this.isTesting;
    }

    // ========================================================================
    // Endpoint Access
    // ========================================================================

    /**
     * Get endpoint URL for current network
     *
     * Handles: custom endpoint > manual selection > auto-selection > fallback
     */
    async getEndpoint(): Promise<string> {
        this.ensureInitialized();

        const provider = this.selector!.getBestProvider(this.network!);
        if (!provider) {
            // Fallback to public endpoint
            this.options.logger.warn('No providers available, using fallback');
            return this.getFallbackEndpoint();
        }

        // Handle dynamic providers (Orbs)
        if (provider.isDynamic && provider.type === 'orbs') {
            try {
                const { getHttpEndpoint } = await import('@orbs-network/ton-access');
                const endpoint = await getHttpEndpoint({ network: this.network! });
                return normalizeV2Endpoint(endpoint);
            } catch (error: any) {
                this.options.logger.warn(`Failed to get Orbs endpoint: ${error.message}`);
                // Fall through to static endpoint
            }
        }

        return normalizeV2Endpoint(provider.endpointV2);
    }

    /**
     * Get endpoint with rate limiting
     *
     * Waits for rate limit token before returning endpoint.
     */
    async getEndpointWithRateLimit(timeoutMs?: number): Promise<string> {
        this.ensureInitialized();

        const provider = this.selector!.getBestProvider(this.network!);
        if (!provider) {
            return this.getFallbackEndpoint();
        }

        // Acquire rate limit token
        const acquired = await this.rateLimiter!.acquire(provider.id, timeoutMs);
        if (!acquired) {
            this.options.logger.warn(`Rate limit timeout for ${provider.id}`);
            // Try next provider
            const next = this.selector!.getNextProvider(this.network!, [provider.id]);
            if (next) {
                return normalizeV2Endpoint(next.endpointV2);
            }
            return this.getFallbackEndpoint();
        }

        return normalizeV2Endpoint(provider.endpointV2);
    }

    /**
     * Get current active provider
     */
    getActiveProvider(): ResolvedProvider | null {
        if (!this.initialized || !this.network) {
            return null;
        }
        return this.selector!.getBestProvider(this.network);
    }

    /**
     * Get active provider info
     */
    getActiveProviderInfo(): { id: string; name: string; isCustom: boolean } | null {
        if (!this.initialized || !this.network) {
            return null;
        }
        return this.selector!.getActiveProviderInfo(this.network);
    }

    // ========================================================================
    // Error Reporting
    // ========================================================================

    /**
     * Report a successful request
     */
    reportSuccess(): void {
        if (!this.initialized || !this.network) return;

        const provider = this.selector!.getBestProvider(this.network);
        if (provider) {
            this.rateLimiter!.reportSuccess(provider.id);
        }
    }

    /**
     * Report an error (triggers provider switch if needed)
     */
    reportError(error: Error | string): void {
        if (!this.initialized || !this.network) return;

        const provider = this.selector!.getBestProvider(this.network);
        if (!provider) return;

        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorMsgLower = errorMsg.toLowerCase();

        // Detect error types to determine how to mark the provider
        const is429 = errorMsgLower.includes('429') || errorMsgLower.includes('rate limit');
        const is503 = errorMsgLower.includes('503') || errorMsgLower.includes('service unavailable');
        const is502 = errorMsgLower.includes('502') || errorMsgLower.includes('bad gateway');
        const is404 = errorMsgLower.includes('404') || errorMsgLower.includes('not found');
        const isTimeout = errorMsgLower.includes('timeout') || errorMsgLower.includes('abort');

        if (isRateLimitError(error) || is429) {
            this.rateLimiter!.reportRateLimitError(provider.id);
            this.healthChecker!.markDegraded(provider.id, this.network, errorMsg);
        } else if (is503 || is502 || is404 || isTimeout) {
            // Server errors, timeouts, and not found should mark provider as offline
            this.rateLimiter!.reportError(provider.id);
            this.healthChecker!.markOffline(provider.id, this.network, errorMsg);
        } else {
            // Other errors - mark as degraded
            this.rateLimiter!.reportError(provider.id);
            this.healthChecker!.markDegraded(provider.id, this.network, errorMsg);
        }

        // Try to switch to next provider
        this.selector!.handleProviderFailure(provider.id, this.network);
        this.notifyListeners();
    }

    // ========================================================================
    // Selection Control
    // ========================================================================

    /**
     * Set manual provider selection
     */
    setSelectedProvider(providerId: string | null): void {
        this.ensureInitialized();
        this.selector!.setSelectedProvider(providerId);
        this.notifyListeners();
    }

    /**
     * Get selected provider ID
     */
    getSelectedProviderId(): string | null {
        if (!this.initialized) return null;
        return this.selector!.getSelectedProviderId();
    }

    /**
     * Set auto-select mode
     */
    setAutoSelect(enabled: boolean): void {
        this.ensureInitialized();
        this.selector!.setAutoSelect(enabled);
        this.notifyListeners();
    }

    /**
     * Check if auto-select is enabled
     */
    isAutoSelectEnabled(): boolean {
        if (!this.initialized) return true;
        return this.selector!.isAutoSelectEnabled();
    }

    /**
     * Set custom endpoint override
     */
    setCustomEndpoint(endpoint: string | null): void {
        this.ensureInitialized();
        this.selector!.setCustomEndpoint(endpoint);
        this.notifyListeners();
    }

    /**
     * Get custom endpoint
     */
    getCustomEndpoint(): string | null {
        if (!this.initialized) return null;
        return this.selector!.getCustomEndpoint();
    }

    /**
     * Check if using custom endpoint
     */
    isUsingCustomEndpoint(): boolean {
        if (!this.initialized) return false;
        return this.selector!.isUsingCustomEndpoint();
    }

    // ========================================================================
    // State Access
    // ========================================================================

    /**
     * Get current network
     */
    getNetwork(): Network | null {
        return this.network;
    }

    /**
     * Get all providers for current network
     */
    getProviders(): ResolvedProvider[] {
        if (!this.initialized || !this.network) return [];
        return this.registry!.getProvidersForNetwork(this.network);
    }

    /**
     * Get provider health results for current network
     */
    getProviderHealthResults(): ProviderHealthResult[] {
        if (!this.initialized || !this.network) return [];
        return this.healthChecker!.getResultsForNetwork(this.network);
    }

    /**
     * Get registry (for advanced usage)
     */
    getRegistry(): ProviderRegistry | null {
        return this.registry;
    }

    /**
     * Get health checker (for advanced usage)
     */
    getHealthChecker(): HealthChecker | null {
        return this.healthChecker;
    }

    /**
     * Get rate limiter manager (for advanced usage)
     */
    getRateLimiter(): RateLimiterManager | null {
        return this.rateLimiter;
    }

    /**
     * Get current state (for UI)
     */
    getState(): ProviderManagerState {
        const providers = new Map<string, ProviderState>();

        if (this.initialized && this.network && this.registry) {
            for (const provider of this.registry.getProvidersForNetwork(this.network)) {
                const health = this.healthChecker?.getResult(provider.id, this.network);
                const rateLimit = this.rateLimiter?.getState(provider.id);

                providers.set(provider.id, {
                    id: provider.id,
                    health: health || {
                        id: provider.id,
                        network: this.network,
                        success: false,
                        status: 'untested',
                        latencyMs: null,
                        seqno: null,
                        blocksBehind: 0,
                        lastTested: null,
                    },
                    rateLimit: rateLimit || {
                        tokens: 0,
                        lastRefill: 0,
                        currentBackoff: 0,
                        consecutiveErrors: 0,
                        processing: false,
                        queueLength: 0,
                    },
                });
            }
        }

        return {
            network: this.network,
            initialized: this.initialized,
            isTesting: this.isTesting,
            providers,
            bestProviderByNetwork: new Map(
                this.network && this.selector
                    ? [[this.network, this.selector.getBestProvider(this.network)?.id || '']]
                    : []
            ),
            selectedProviderId: this.selector?.getSelectedProviderId() || null,
            autoSelect: this.selector?.isAutoSelectEnabled() ?? true,
            customEndpoint: this.selector?.getCustomEndpoint() || null,
        };
    }

    // ========================================================================
    // State Listeners
    // ========================================================================

    /**
     * Subscribe to state changes
     */
    subscribe(listener: StateListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Notify all listeners
     */
    private notifyListeners(): void {
        const state = this.getState();
        this.listeners.forEach((listener) => listener(state));
    }

    // ========================================================================
    // Private Helpers
    // ========================================================================

    private ensureInitialized(): void {
        if (!this.initialized) {
            throw new Error('ProviderManager not initialized. Call init() first.');
        }
    }

    private getFallbackEndpoint(): string {
        if (this.network === 'mainnet') {
            return 'https://toncenter.com/api/v2/jsonRPC';
        }
        return 'https://testnet.toncenter.com/api/v2/jsonRPC';
    }

    private startHealthCheckInterval(): void {
        this.stopHealthCheckInterval();

        this.healthCheckInterval = setInterval(() => {
            this.testAllProviders().catch((error) => {
                this.options.logger.error(`Health check interval failed: ${error.message}`);
            });
        }, this.options.healthCheckIntervalMs);

        this.options.logger.debug(
            `Started health check interval: ${this.options.healthCheckIntervalMs}ms`
        );
    }

    private stopHealthCheckInterval(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new ProviderManager instance
 */
export function createProviderManager(options?: ProviderManagerOptions): ProviderManager {
    return new ProviderManager(options);
}

/**
 * Get singleton ProviderManager instance
 */
export function getProviderManager(options?: ProviderManagerOptions): ProviderManager {
    return ProviderManager.getInstance(options);
}
