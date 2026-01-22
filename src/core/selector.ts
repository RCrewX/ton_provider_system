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

    // Selection state
    private selectedProviderId: string | null = null;
    private autoSelect: boolean = true;
    private customEndpoint: string | null = null;
    private bestProviderByNetwork: Map<Network, string> = new Map();

    constructor(
        registry: ProviderRegistry,
        healthChecker: HealthChecker,
        config?: Partial<SelectionConfig>,
        logger?: Logger
    ) {
        this.registry = registry;
        this.healthChecker = healthChecker;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.logger = logger || consoleLogger;
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
            if (cached && health && this.config.minStatus.includes(health.status)) {
                return cached;
            }
        }

        // Find new best provider
        return this.findBestProvider(network);
    }

    /**
     * Find the best provider for a network (recalculates)
     */
    findBestProvider(network: Network): ResolvedProvider | null {
        const providers = this.registry.getProvidersForNetwork(network);
        if (providers.length === 0) {
            this.logger.warn(`No providers available for ${network}`);
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
            const defaults = this.registry.getDefaultOrderForNetwork(network);
            if (defaults.length > 0) {
                this.logger.warn(`No healthy providers for ${network}, using first default`);
                return defaults[0];
            }
            return providers[0];
        }

        const best = scored[0].provider;
        this.bestProviderByNetwork.set(network, best.id);
        this.logger.debug(
            `Best provider for ${network}: ${best.id} (score: ${scored[0].score.toFixed(2)})`
        );

        return best;
    }

    /**
     * Get all available providers for a network, sorted by score
     */
    getAvailableProviders(network: Network): ResolvedProvider[] {
        const providers = this.registry.getProvidersForNetwork(network);

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
        const providers = this.registry.getProvidersForNetwork(network);

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

        // No health data = untested = low score but not zero
        if (!health || health.status === 'untested') {
            return 0.1 * (1 / (provider.priority + 1));
        }

        // Providers that failed health check should not be selected
        // Even if status is 'degraded' (e.g., HTTP 429), if success=false, don't use it
        if (health.success === false) {
            return 0;
        }

        // Offline providers get zero score
        if (health.status === 'offline') {
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
     */
    clearCache(): void {
        this.bestProviderByNetwork.clear();
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

        // Find next best
        return this.getNextProvider(network, [providerId]);
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
        };
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
    logger?: Logger
): ProviderSelector {
    return new ProviderSelector(registry, healthChecker, config, logger);
}
