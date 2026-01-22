/**
 * Unified Provider System - Provider Registry
 *
 * Manages provider definitions, filtering, and lookup.
 * Acts as a central repository for all available providers.
 */

import type {
    RpcConfig,
    ResolvedProvider,
    Network,
    ProviderType,
    Logger,
} from '../types';
import {
    loadConfig,
    resolveAllProviders,
    getProvidersForNetwork,
    getDefaultProvidersForNetwork,
    mergeWithDefaults,
    createDefaultConfig,
} from '../config';

// ============================================================================
// Console Logger (default)
// ============================================================================

const consoleLogger: Logger = {
    debug: (msg, data) => console.debug(`[ProviderRegistry] ${msg}`, data || ''),
    info: (msg, data) => console.log(`[ProviderRegistry] ${msg}`, data || ''),
    warn: (msg, data) => console.warn(`[ProviderRegistry] ${msg}`, data || ''),
    error: (msg, data) => console.error(`[ProviderRegistry] ${msg}`, data || ''),
};

// ============================================================================
// Provider Registry
// ============================================================================

/**
 * Provider Registry
 *
 * Manages all provider definitions and provides lookup/filtering capabilities.
 */
export class ProviderRegistry {
    private config: RpcConfig;
    private providers: Map<string, ResolvedProvider> = new Map();
    private logger: Logger;

    constructor(config?: RpcConfig, logger?: Logger) {
        this.config = config || createDefaultConfig();
        this.logger = logger || consoleLogger;
        this.loadProviders();
    }

    /**
     * Load and resolve all providers from config
     */
    private loadProviders(): void {
        this.providers.clear();

        const resolved = resolveAllProviders(this.config);
        for (const provider of resolved) {
            this.providers.set(provider.id, provider);
        }

        this.logger.info(`Loaded ${this.providers.size} providers`);
    }

    /**
     * Get a provider by ID
     */
    getProvider(id: string): ResolvedProvider | undefined {
        return this.providers.get(id);
    }

    /**
     * Get all providers
     */
    getAllProviders(): ResolvedProvider[] {
        return Array.from(this.providers.values());
    }

    /**
     * Get providers for a specific network
     */
    getProvidersForNetwork(network: Network): ResolvedProvider[] {
        return Array.from(this.providers.values()).filter(
            (p) => p.network === network
        );
    }

    /**
     * Get providers in default order for a network
     */
    getDefaultOrderForNetwork(network: Network): ResolvedProvider[] {
        return getDefaultProvidersForNetwork(this.config, network);
    }

    /**
     * Get providers by type
     */
    getProvidersByType(type: ProviderType): ResolvedProvider[] {
        return Array.from(this.providers.values()).filter(
            (p) => p.type === type
        );
    }

    /**
     * Get providers that have v2 API endpoints
     */
    getV2Providers(): ResolvedProvider[] {
        return Array.from(this.providers.values()).filter(
            (p) => p.endpointV2 && p.endpointV2.length > 0
        );
    }

    /**
     * Get v2 providers for a specific network
     */
    getV2ProvidersForNetwork(network: Network): ResolvedProvider[] {
        return this.getProvidersForNetwork(network).filter(
            (p) => p.endpointV2 && p.endpointV2.length > 0
        );
    }

    /**
     * Check if a provider exists
     */
    hasProvider(id: string): boolean {
        return this.providers.has(id);
    }

    /**
     * Get provider count
     */
    get size(): number {
        return this.providers.size;
    }

    /**
     * Get the underlying config
     */
    getConfig(): RpcConfig {
        return this.config;
    }

    /**
     * Update config and reload providers
     */
    updateConfig(config: RpcConfig): void {
        this.config = config;
        this.loadProviders();
    }

    /**
     * Add or update a provider at runtime
     */
    setProvider(id: string, provider: ResolvedProvider): void {
        this.providers.set(id, provider);
        this.logger.debug(`Provider ${id} added/updated`);
    }

    /**
     * Remove a provider
     */
    removeProvider(id: string): boolean {
        const removed = this.providers.delete(id);
        if (removed) {
            this.logger.debug(`Provider ${id} removed`);
        }
        return removed;
    }

    /**
     * Get provider IDs
     */
    getProviderIds(): string[] {
        return Array.from(this.providers.keys());
    }

    /**
     * Get network default provider IDs
     */
    getDefaultProviderIds(network: Network): string[] {
        return this.config.defaults[network];
    }

    /**
     * Find provider by endpoint URL (useful for error reporting)
     */
    findProviderByEndpoint(endpoint: string): ResolvedProvider | undefined {
        const normalizedEndpoint = endpoint.toLowerCase().replace(/\/jsonrpc$/i, '');

        for (const provider of this.providers.values()) {
            const v2Normalized = provider.endpointV2?.toLowerCase().replace(/\/jsonrpc$/i, '');
            const v3Normalized = provider.endpointV3?.toLowerCase().replace(/\/jsonrpc$/i, '');

            if (v2Normalized && normalizedEndpoint.includes(v2Normalized.split('/api/')[0])) {
                return provider;
            }
            if (v3Normalized && normalizedEndpoint.includes(v3Normalized.split('/api/')[0])) {
                return provider;
            }
        }

        return undefined;
    }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a registry by loading from provider_system/rpc.json
 */
export async function createRegistry(logger?: Logger): Promise<ProviderRegistry> {
    const config = await loadConfig();
    const mergedConfig = mergeWithDefaults(config);
    return new ProviderRegistry(mergedConfig, logger);
}

/**
 * @deprecated Use createRegistry() instead
 */
export async function createRegistryFromFile(
    _filePath?: string,
    logger?: Logger
): Promise<ProviderRegistry> {
    return createRegistry(logger);
}

/**
 * Create a registry with default providers only
 */
export function createDefaultRegistry(logger?: Logger): ProviderRegistry {
    const config = createDefaultConfig();
    return new ProviderRegistry(config, logger);
}

/**
 * Create a registry from raw config data
 */
export function createRegistryFromData(
    data: RpcConfig,
    logger?: Logger
): ProviderRegistry {
    const mergedConfig = mergeWithDefaults(data);
    return new ProviderRegistry(mergedConfig, logger);
}
