/**
 * Unified Provider System - Configuration Parser
 *
 * Loads provider definitions from provider_system/rpc.json.
 * Resolves API keys from environment variables (.env).
 * Supports both Node.js (file system) and browser (fetch/embedded) environments.
 */

import type {
    RpcConfig,
    ProviderConfig,
    ResolvedProvider,
    Network,
} from '../types';
import { parseRpcConfig, createEmptyConfig } from './schema';

// ============================================================================
// Constants
// ============================================================================

/**
 * Path to the RPC configuration file relative to provider_system folder
 */
const RPC_CONFIG_FILENAME = 'rpc.json';

// ============================================================================
// Environment Resolution
// ============================================================================

/**
 * Get environment variable value.
 * Works in both Node.js and browser environments.
 */
export function getEnvVar(name: string): string | undefined {
    // Node.js environment
    if (typeof process !== 'undefined' && process.env) {
        return process.env[name];
    }
    // Browser environment - check for global config
    if (typeof window !== 'undefined' && (window as any).__ENV__) {
        return (window as any).__ENV__[name];
    }
    return undefined;
}

/**
 * Resolve {key} placeholder in URL with environment variable value
 */
export function resolveKeyPlaceholder(url: string, keyEnvVar?: string): string {
    if (!keyEnvVar || !url.includes('{key}')) {
        return url;
    }

    const key = getEnvVar(keyEnvVar);
    if (!key) {
        // Return URL without replacement - will fail at runtime if key is required
        console.warn(`[ConfigParser] Environment variable ${keyEnvVar} not set for URL: ${url}`);
        return url;
    }

    return url.replace('{key}', key);
}

/**
 * Resolve all placeholders in endpoint URLs
 */
export function resolveEndpoints(
    endpoints: ProviderConfig['endpoints'],
    keyEnvVar?: string
): { v2?: string; v3?: string; v4?: string; ws?: string } {
    return {
        v2: endpoints.v2 ? resolveKeyPlaceholder(endpoints.v2, keyEnvVar) : undefined,
        v3: endpoints.v3 ? resolveKeyPlaceholder(endpoints.v3, keyEnvVar) : undefined,
        v4: endpoints.v4 ? resolveKeyPlaceholder(endpoints.v4, keyEnvVar) : undefined,
        ws: endpoints.ws ? resolveKeyPlaceholder(endpoints.ws, keyEnvVar) : undefined,
    };
}

// ============================================================================
// Provider Resolution
// ============================================================================

/**
 * Convert a ProviderConfig to a ResolvedProvider with actual URLs
 */
export function resolveProvider(id: string, config: ProviderConfig): ResolvedProvider | null {
    // Skip disabled providers
    if (!config.enabled) {
        return null;
    }

    // Resolve endpoint URLs
    const resolved = resolveEndpoints(config.endpoints, config.keyEnvVar);

    // Must have at least v2 endpoint for most operations
    if (!resolved.v2 && !resolved.v3 && !resolved.v4) {
        console.warn(`[ConfigParser] Provider ${id} has no valid endpoints after resolution`);
        return null;
    }

    // Get API key - check both apiKeyEnvVar and keyEnvVar
    // For OnFinality, the key is in keyEnvVar (used in URL), but we also need it in apiKey field
    let apiKey = config.apiKeyEnvVar ? getEnvVar(config.apiKeyEnvVar) : undefined;
    
    // If no apiKeyEnvVar but keyEnvVar exists and was used, extract from resolved endpoint
    if (!apiKey && config.keyEnvVar && config.type === 'onfinality') {
        // For OnFinality, the API key might be in the resolved URL query params
        // Try to get it from environment variable directly
        apiKey = getEnvVar(config.keyEnvVar);
    }

    return {
        id,
        name: config.name,
        type: config.type,
        network: config.network,
        endpointV2: resolved.v2 || resolved.v3 || '', // Fallback to v3 if v2 not available
        endpointV3: resolved.v3,
        endpointV4: resolved.v4,
        endpointWs: resolved.ws,
        apiKey,
        rps: config.rps,
        priority: config.priority,
        isDynamic: config.isDynamic || false,
        browserCompatible: config.browserCompatible !== undefined ? config.browserCompatible : true,
    };
}

/**
 * Resolve all providers from config
 */
export function resolveAllProviders(config: RpcConfig): ResolvedProvider[] {
    const resolved: ResolvedProvider[] = [];

    for (const [id, providerConfig] of Object.entries(config.providers)) {
        const provider = resolveProvider(id, providerConfig);
        if (provider) {
            resolved.push(provider);
        }
    }

    return resolved;
}

/**
 * Get providers for a specific network
 */
export function getProvidersForNetwork(
    config: RpcConfig,
    network: Network
): ResolvedProvider[] {
    const all = resolveAllProviders(config);
    return all.filter((p) => p.network === network);
}

/**
 * Get providers in default order for a network
 */
export function getDefaultProvidersForNetwork(
    config: RpcConfig,
    network: Network
): ResolvedProvider[] {
    const defaultOrder = config.defaults[network];
    const networkProviders = getProvidersForNetwork(config, network);

    // Sort by default order, then by priority
    const inOrder: ResolvedProvider[] = [];
    const remaining: ResolvedProvider[] = [];

    for (const provider of networkProviders) {
        const defaultIndex = defaultOrder.indexOf(provider.id);
        if (defaultIndex !== -1) {
            inOrder[defaultIndex] = provider;
        } else {
            remaining.push(provider);
        }
    }

    // Filter out empty slots and add remaining providers
    const orderedProviders = inOrder.filter(Boolean);
    remaining.sort((a, b) => a.priority - b.priority);

    return [...orderedProviders, ...remaining];
}

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Load RPC config from the built-in rpc.json file (Node.js)
 */
export async function loadBuiltinConfig(): Promise<RpcConfig> {
    // Dynamic import for Node.js modules
    const fs = await import('fs').then((m) => m.promises);
    const path = await import('path');
    const { fileURLToPath } = await import('url');

    // Get __dirname equivalent for ESM
    const getDirname = () => {
        try {
            // ESM: use import.meta.url
            if (import.meta.url) {
                return path.dirname(fileURLToPath(import.meta.url));
            }
        } catch {
            // Fallback for CommonJS (shouldn't happen in ESM)
        }
        return process.cwd();
    };
    const dirname = getDirname();

    // Find the rpc.json file - it's in the provider_system folder
    // Try multiple paths to handle different execution contexts
    const possiblePaths = [
        // When running from project root (e.g., ts-node scripts/...)
        path.resolve(process.cwd(), 'provider_system', RPC_CONFIG_FILENAME),
        // When running from provider_system folder
        path.resolve(process.cwd(), RPC_CONFIG_FILENAME),
        // Relative to this file (ESM style)
        path.resolve(dirname, '..', RPC_CONFIG_FILENAME),
    ];

    for (const configPath of possiblePaths) {
        try {
            const content = await fs.readFile(configPath, 'utf-8');
            const data = JSON.parse(content);
            return parseRpcConfig(data);
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                throw new Error(`Failed to load RPC config from ${configPath}: ${error.message}`);
            }
            // File not found, try next path
        }
    }

    // No config file found, use defaults
    console.warn(`[ConfigParser] Config file ${RPC_CONFIG_FILENAME} not found, using defaults`);
    return createDefaultConfig();
}

/**
 * Load RPC config from a URL (browser-compatible)
 */
export async function loadConfigFromUrl(url: string): Promise<RpcConfig> {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        return parseRpcConfig(data);
    } catch (error: any) {
        throw new Error(`Failed to load RPC config from ${url}: ${error.message}`);
    }
}

/**
 * Load RPC config from raw JSON data
 */
export function loadConfigFromData(data: unknown): RpcConfig {
    return parseRpcConfig(data);
}

/**
 * Auto-detect and load config.
 * - Browser: checks for embedded __RPC_CONFIG__ or fetches from URL
 * - Node.js: loads from provider_system/rpc.json
 */
export async function loadConfig(): Promise<RpcConfig> {
    // Check for embedded config in browser
    if (typeof window !== 'undefined' && (window as any).__RPC_CONFIG__) {
        return parseRpcConfig((window as any).__RPC_CONFIG__);
    }

    // Node.js: load from built-in rpc.json
    if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
        return loadBuiltinConfig();
    }

    // Fallback to default config
    console.warn('[ConfigParser] No config source available, using defaults');
    return createDefaultConfig();
}

// ============================================================================
// Default Provider Configurations (fallback)
// ============================================================================

/**
 * Minimal default providers when rpc.json is not available.
 * These are free public endpoints that don't require API keys.
 */
export const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
    toncenter_testnet: {
        name: 'TON Center Testnet',
        type: 'toncenter',
        network: 'testnet',
        endpoints: {
            v2: 'https://testnet.toncenter.com/api/v2',
        },
        rps: 1, // Without API key
        priority: 100,
        enabled: true,
        description: 'Official TON Center public endpoint',
    },
    orbs_testnet: {
        name: 'Orbs TON Access Testnet',
        type: 'orbs',
        network: 'testnet',
        endpoints: {
            v2: 'https://ton-testnet.orbs.network/api/v2',
        },
        rps: 10,
        priority: 50,
        enabled: true,
        isDynamic: true,
        description: 'Decentralized gateway - no API key needed',
    },
    toncenter_mainnet: {
        name: 'TON Center Mainnet',
        type: 'toncenter',
        network: 'mainnet',
        endpoints: {
            v2: 'https://toncenter.com/api/v2',
        },
        rps: 1, // Without API key
        priority: 100,
        enabled: true,
        description: 'Official TON Center public endpoint',
    },
    orbs_mainnet: {
        name: 'Orbs TON Access Mainnet',
        type: 'orbs',
        network: 'mainnet',
        endpoints: {
            v2: 'https://ton-mainnet.orbs.network/api/v2',
        },
        rps: 10,
        priority: 50,
        enabled: true,
        isDynamic: true,
        description: 'Decentralized gateway - no API key needed',
    },
};

/**
 * Create a default config with minimal providers (no API keys required)
 */
export function createDefaultConfig(): RpcConfig {
    return {
        version: '1.0',
        providers: { ...DEFAULT_PROVIDERS },
        defaults: {
            testnet: ['orbs_testnet', 'toncenter_testnet'],
            mainnet: ['orbs_mainnet', 'toncenter_mainnet'],
        },
    };
}

/**
 * Merge user config with defaults
 */
export function mergeWithDefaults(config: RpcConfig): RpcConfig {
    const defaults = createDefaultConfig();

    return {
        ...config,
        providers: {
            ...defaults.providers,
            ...config.providers,
        },
        defaults: {
            testnet: config.defaults.testnet.length > 0
                ? config.defaults.testnet
                : defaults.defaults.testnet,
            mainnet: config.defaults.mainnet.length > 0
                ? config.defaults.mainnet
                : defaults.defaults.mainnet,
        },
    };
}
