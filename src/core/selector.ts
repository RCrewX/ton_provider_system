/**
 * Unified Provider System - Provider Selector
 *
 * Selects the best available provider based on health, latency, and priority.
 * Supports auto-selection, manual override, and custom endpoint.
 */

import type {
    ResolvedProvider,
    ProviderHealthResult,
    ProviderStatus,
    Network,
    Logger,
} from '../types';
import { ProviderRegistry } from './registry';
import { HealthChecker } from './healthChecker';

// ============================================================================
// Console Logger (default)
// ============================================================================

const consoleLogger: Logger = {
    debug: (msg, data) => console.debug(`[ProviderSelector] ${msg}`, data || ''),
    info: (msg, data) => console.log(`[ProviderSelector] ${msg}`, data || ''),
    warn: (msg, data) => console.warn(`[ProviderSelector] ${msg}`, data || ''),
    error: (msg, data) => console.error(`[ProviderSelector] ${msg}`, data || ''),
};

// ============================================================================
// Selection Configuration
// ============================================================================

export interface SelectionConfig {
    /** Prefer providers with latency below this threshold (ms) */
    preferredLatencyMs: number;
    /** Weight for latency in scoring (0-1) */
    latencyWeight: number;
    /** Weight for priority in scoring (0-1) */
    priorityWeight: number;
    /** Weight for block freshness in scoring (0-1) */
    freshnessWeight: number;
    /** Minimum acceptable provider status */
    minStatus: ProviderStatus[];
}

const DEFAULT_CONFIG: SelectionConfig = {
    preferredLatencyMs: 1000,
    latencyWeight: 0.4,
    priorityWeight: 0.3,
    freshnessWeight: 0.3,
    minStatus: ['available', 'degraded'],
};

// ============================================================================
// Provider Selector
// ============================================================================

/**
 * Provider Selector
 *
 * Selects the best provider based on multiple criteria:
 * - Health status (available > degraded > offline)
 * - Latency (lower is better)
 * - Priority (from config, lower is higher priority)
 * - Block freshness (fewer blocks behind is better)
 */
export class ProviderSelector {
    private registry: ProviderRegistry;
    private healthChecker: HealthChecker;
    private config: SelectionConfig;
    private logger: Logger;
    private adapter: 'node' | 'browser';

    // Selection state
    private selectedProviderId: string | null = null;
    private autoSelect: boolean = true;
    private customEndpoint: string | null = null;
    private bestProviderByNetwork: Map<Network, string> = new Map();
    // Track currently active provider per network (the one actually being used)
    private activeProviderByNetwork: Map<Network, string> = new Map();

    constructor(
        registry: ProviderRegistry,
        healthChecker: HealthChecker,
        config?: Partial<SelectionConfig>,
        logger?: Logger,
        adapter: 'node' | 'browser' = 'node'
    ) {
        this.registry = registry;
        this.healthChecker = healthChecker;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.logger = logger || consoleLogger;
        this.adapter = adapter;
    }

    // ========================================================================
    // Selection Methods
    // ========================================================================

    /**
     * Get the best provider for a network
     */
    getBestProvider(network: Network): ResolvedProvider | null {
        // Custom endpoint override
        if (this.customEndpoint) {
            return this.createCustomProvider(network);
        }

        // Manual selection
        if (!this.autoSelect && this.selectedProviderId) {
            const provider = this.registry.getProvider(this.selectedProviderId);
            if (provider && provider.network === network) {
                // Track active provider
                this.activeProviderByNetwork.set(network, provider.id);
                return provider;
            }
            this.logger.warn(
                `Selected provider ${this.selectedProviderId} not found or wrong network, using auto-select`
            );
        }

        // Auto-selection: use cached best or find new
        const cachedBestId = this.bestProviderByNetwork.get(network);
        if (cachedBestId) {
            const cached = this.registry.getProvider(cachedBestId);
            const health = this.healthChecker.getResult(cachedBestId, network);

            // Verify cached provider is still healthy
            // CRITICAL: Must check success: false first - never use failed providers
            if (
                cached &&
                health &&
                health.success !== false &&
                health.success !== undefined && // Explicitly check for undefined
                this.config.minStatus.includes(health.status)
            ) {
                // Update active provider tracking
                this.activeProviderByNetwork.set(network, cachedBestId);
                return cached;
            } else {
                // Cached provider is no longer healthy, clear cache
                this.bestProviderByNetwork.delete(network);
                this.activeProviderByNetwork.delete(network);
            }
        }

        // Find new best provider
        return this.findBestProvider(network);
    }

    /**
     * Find the best provider for a network (recalculates)
     */
    findBestProvider(network: Network): ResolvedProvider | null {
        let providers = this.registry.getProvidersForNetwork(network);
        
        // Filter browser-incompatible providers when running in browser
        if (this.adapter === 'browser') {
            const beforeCount = providers.length;
            providers = this.filterBrowserCompatible(providers, network);
            const filteredCount = beforeCount - providers.length;
            if (filteredCount > 0) {
                this.logger.debug(
                    `Filtered out ${filteredCount} browser-incompatible provider(s) for ${network}`
                );
            }
        }
        
        if (providers.length === 0) {
            this.logger.warn(`No browser-compatible providers available for ${network}`);
            return null;
        }

        // Score each provider
        const scored = providers
            .map((provider) => ({
                provider,
                score: this.scoreProvider(provider, network),
            }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score);

        if (scored.length === 0) {
            // Fall back to default order if no healthy providers
            // Allow retrying failed providers after cooldown period
            const defaults = this.registry.getDefaultOrderForNetwork(network);
            for (const defaultProvider of defaults) {
                const health = this.healthChecker.getResult(defaultProvider.id, network);
                
                // Untested - safe to try
                if (!health || health.status === 'untested') {
                    this.logger.warn(
                        `No healthy providers for ${network}, using untested default: ${defaultProvider.id}`
                    );
                    this.activeProviderByNetwork.set(network, defaultProvider.id);
                    return defaultProvider;
                }
                
                // Explicitly succeeded - safe to use
                if (health.success === true) {
                    this.logger.warn(
                        `No healthy providers for ${network}, using default: ${defaultProvider.id}`
                    );
                    this.activeProviderByNetwork.set(network, defaultProvider.id);
                    return defaultProvider;
                }
                
                // Failed provider - check if cooldown expired
                if (health.success === false && health.lastTested) {
                    const timeSinceFailure = Date.now() - health.lastTested.getTime();
                    const cooldownMs = 30000; // 30 seconds cooldown
                    
                    if (timeSinceFailure > cooldownMs) {
                        // Cooldown expired - allow retry
                        this.logger.warn(
                            `No healthy providers for ${network}, retrying failed default after cooldown: ${defaultProvider.id}`
                        );
                        this.activeProviderByNetwork.set(network, defaultProvider.id);
                        return defaultProvider;
                    }
                }
                // Still in cooldown - skip this provider
            }
            
            // If all defaults failed, try any untested provider or retry failed ones after cooldown
            for (const provider of providers) {
                const health = this.healthChecker.getResult(provider.id, network);
                
                // Untested providers
                if (!health || health.status === 'untested') {
                    this.logger.warn(
                        `No tested healthy providers for ${network}, using untested: ${provider.id}`
                    );
                    this.activeProviderByNetwork.set(network, provider.id);
                    return provider;
                }
                
                // Failed provider - check if cooldown expired
                if (health.success === false && health.lastTested) {
                    const timeSinceFailure = Date.now() - health.lastTested.getTime();
                    const cooldownMs = 30000; // 30 seconds cooldown
                    
                    if (timeSinceFailure > cooldownMs) {
                        // Cooldown expired - allow retry
                        this.logger.warn(
                            `No healthy providers for ${network}, retrying failed provider after cooldown: ${provider.id}`
                        );
                        this.activeProviderByNetwork.set(network, provider.id);
                        return provider;
                    }
                }
            }
            
            // Last resort: return null (caller should handle this)
            this.logger.error(`No available providers for ${network} (all tested and failed, cooldown active)`);
            return null;
        }

        const best = scored[0].provider;
        const bestHealth = this.healthChecker.getResult(best.id, network);
        
        // Only cache and log if provider has been tested and is healthy
        if (bestHealth && bestHealth.success === true) {
            this.bestProviderByNetwork.set(network, best.id);
            this.activeProviderByNetwork.set(network, best.id);
            this.logger.debug(
                `Best provider for ${network}: ${best.id} (score: ${scored[0].score.toFixed(2)})`
            );
        } else {
            // Don't cache untested providers, but still return them as fallback
            // Track active provider even if untested (so we know which one failed)
            this.activeProviderByNetwork.set(network, best.id);
            this.logger.debug(
                `Best provider for ${network}: ${best.id} (score: ${scored[0].score.toFixed(2)}, untested)`
            );
        }

        return best;
    }

    /**
     * Get all available providers for a network, sorted by score
     */
    getAvailableProviders(network: Network): ResolvedProvider[] {
        let providers = this.registry.getProvidersForNetwork(network);
        
        // Filter browser-incompatible providers when running in browser
        if (this.adapter === 'browser') {
            providers = this.filterBrowserCompatible(providers, network);
        }

        return providers
            .map((provider) => ({
                provider,
                score: this.scoreProvider(provider, network),
            }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((item) => item.provider);
    }

    /**
     * Get the next best provider (for failover)
     */
    getNextProvider(
        network: Network,
        excludeIds: string[]
    ): ResolvedProvider | null {
        let providers = this.registry.getProvidersForNetwork(network);
        
        // Filter browser-incompatible providers when running in browser
        if (this.adapter === 'browser') {
            providers = this.filterBrowserCompatible(providers, network);
        }

        const available = providers
            .filter((p) => !excludeIds.includes(p.id))
            .map((provider) => ({
                provider,
                score: this.scoreProvider(provider, network),
            }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score);

        if (available.length === 0) {
            return null;
        }

        return available[0].provider;
    }

    // ========================================================================
    // Scoring
    // ========================================================================

    /**
     * Calculate a score for a provider (higher is better)
     */
    private scoreProvider(provider: ResolvedProvider, network: Network): number {
        const health = this.healthChecker.getResult(provider.id, network);

        // No health data = untested = very low score (only used as last resort)
        // Prefer tested providers even if they're degraded over untested ones
        if (!health || health.status === 'untested') {
            return 0.01 * (1 / (provider.priority + 1));
        }

        // Providers that failed health check (success: false) - allow retry after cooldown
        // This allows providers to recover from temporary failures (503, network errors, etc.)
        if (health.success === false) {
            // If last tested was more than 30 seconds ago, allow retry with very low score
            // This gives providers a chance to recover from temporary failures
            if (health.lastTested) {
                const timeSinceFailure = Date.now() - health.lastTested.getTime();
                const cooldownMs = 30000; // 30 seconds cooldown
                
                if (timeSinceFailure > cooldownMs) {
                    // Cooldown expired - allow retry with very low score
                    // Lower priority = higher score multiplier (inverse relationship)
                    return 0.001 * (1 / (provider.priority + 1));
                }
            }
            // Still in cooldown - don't use
            return 0;
        }

        // Offline providers (status: offline) - also allow retry after cooldown
        // Offline providers have success: false, so they're already handled above
        // But we check status here to be explicit
        if (health.status === 'offline') {
            // Already handled in the success: false check above, but if somehow
            // an offline provider has success: true, still don't use it
            return 0;
        }

        // Check minimum status
        if (!this.config.minStatus.includes(health.status)) {
            return 0;
        }

        // Calculate component scores (0-1)
        const statusScore = this.getStatusScore(health.status);
        const latencyScore = this.getLatencyScore(health.latencyMs);
        const priorityScore = this.getPriorityScore(provider.priority);
        const freshnessScore = this.getFreshnessScore(health.blocksBehind);

        // Weighted combination
        const score =
            statusScore * 0.2 + // Base status score
            latencyScore * this.config.latencyWeight +
            priorityScore * this.config.priorityWeight +
            freshnessScore * this.config.freshnessWeight;

        return score;
    }

    private getStatusScore(status: ProviderStatus): number {
        switch (status) {
            case 'available':
                return 1.0;
            case 'degraded':
                return 0.5;
            case 'stale':
                return 0.3;
            default:
                return 0;
        }
    }

    private getLatencyScore(latencyMs: number | null): number {
        if (latencyMs === null) {
            return 0.5; // Unknown latency gets middle score
        }

        // Score based on preferred latency (exponential decay)
        const ratio = latencyMs / this.config.preferredLatencyMs;
        return Math.max(0, 1 - Math.log(ratio + 1) / Math.log(11));
    }

    private getPriorityScore(priority: number): number {
        // Priority 0 = score 1, priority 100 = score 0
        return Math.max(0, 1 - priority / 100);
    }

    private getFreshnessScore(blocksBehind: number): number {
        // 0 blocks behind = score 1, 10+ blocks = score 0
        return Math.max(0, 1 - blocksBehind / 10);
    }

    // ========================================================================
    // Selection Control
    // ========================================================================

    /**
     * Set manual provider selection
     */
    setSelectedProvider(providerId: string | null): void {
        this.selectedProviderId = providerId;
        if (providerId !== null) {
            this.autoSelect = false;
        }
        this.logger.info(`Selected provider: ${providerId || '(auto)'}`);
    }

    /**
     * Get currently selected provider ID
     */
    getSelectedProviderId(): string | null {
        return this.selectedProviderId;
    }

    /**
     * Enable/disable auto-selection
     */
    setAutoSelect(enabled: boolean): void {
        this.autoSelect = enabled;
        if (enabled) {
            this.selectedProviderId = null;
        }
        this.logger.info(`Auto-select: ${enabled}`);
    }

    /**
     * Check if auto-selection is enabled
     */
    isAutoSelectEnabled(): boolean {
        return this.autoSelect;
    }

    /**
     * Set custom endpoint override
     */
    setCustomEndpoint(endpoint: string | null): void {
        this.customEndpoint = endpoint?.trim() || null;
        this.logger.info(`Custom endpoint: ${this.customEndpoint || '(none)'}`);
    }

    /**
     * Get custom endpoint
     */
    getCustomEndpoint(): string | null {
        return this.customEndpoint;
    }

    /**
     * Check if using custom endpoint
     */
    isUsingCustomEndpoint(): boolean {
        return this.customEndpoint !== null && this.customEndpoint.length > 0;
    }

    /**
     * Clear cached best providers (forces recalculation)
     * @param network - Optional network to clear cache for. If not provided, clears all networks.
     */
    clearCache(network?: Network): void {
        if (network) {
            this.bestProviderByNetwork.delete(network);
            this.activeProviderByNetwork.delete(network);
        } else {
            this.bestProviderByNetwork.clear();
            this.activeProviderByNetwork.clear();
        }
    }

    /**
     * Update best provider after health check
     */
    updateBestProvider(network: Network): void {
        this.findBestProvider(network);
    }

    /**
     * Handle provider failure (switch to next best)
     */
    handleProviderFailure(providerId: string, network: Network): ResolvedProvider | null {
        // Clear cached best if it was the failing provider
        if (this.bestProviderByNetwork.get(network) === providerId) {
            this.bestProviderByNetwork.delete(network);
        }
        
        // Clear active provider cache for this network to force re-selection
        this.activeProviderByNetwork.delete(network);

        // Find next best
        return this.getNextProvider(network, [providerId]);
    }
    
    /**
     * Get the currently active provider ID for a network
     * (the one that was last selected and is being used)
     */
    getActiveProviderId(network: Network): string | null {
        return this.activeProviderByNetwork.get(network) || null;
    }

    // ========================================================================
    // Info
    // ========================================================================

    /**
     * Get active provider info
     */
    getActiveProviderInfo(
        network: Network
    ): { id: string; name: string; isCustom: boolean } | null {
        if (this.customEndpoint) {
            return { id: 'custom', name: 'Custom Endpoint', isCustom: true };
        }

        const provider = this.getBestProvider(network);
        if (provider) {
            return { id: provider.id, name: provider.name, isCustom: false };
        }

        return null;
    }

    // ========================================================================
    // Private Helpers
    // ========================================================================

    /**
     * Create a pseudo-provider for custom endpoint
     */
    private createCustomProvider(network: Network): ResolvedProvider {
        return {
            id: 'custom',
            name: 'Custom Endpoint',
            type: 'custom',
            network,
            endpointV2: this.customEndpoint!,
            rps: 10,
            priority: 0,
            isDynamic: false,
            browserCompatible: true, // Custom endpoints are assumed compatible
        };
    }

    /**
     * Filter providers to only include browser-compatible ones
     * 
     * Checks both:
     * 1. Provider config browserCompatible flag
     * 2. Health check result browserCompatible flag (if health check was performed)
     */
    private filterBrowserCompatible(
        providers: ResolvedProvider[],
        network: Network
    ): ResolvedProvider[] {
        return providers.filter((provider) => {
            // Check provider config flag
            if (!provider.browserCompatible) {
                this.logger.debug(
                    `Provider ${provider.id} marked as browser-incompatible in config`
                );
                return false;
            }

            // Check health check result (if available)
            const health = this.healthChecker.getResult(provider.id, network);
            if (health && health.browserCompatible === false) {
                this.logger.debug(
                    `Provider ${provider.id} marked as browser-incompatible by health check (CORS error detected)`
                );
                return false;
            }

            return true;
        });
    }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a provider selector
 */
export function createSelector(
    registry: ProviderRegistry,
    healthChecker: HealthChecker,
    config?: Partial<SelectionConfig>,
    logger?: Logger,
    adapter: 'node' | 'browser' = 'node'
): ProviderSelector {
    return new ProviderSelector(registry, healthChecker, config, logger, adapter);
}
