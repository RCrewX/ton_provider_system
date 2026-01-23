/**
 * Unified Provider System - Configuration Schema
 *
 * Zod schema for validating rpc.json configuration files.
 * Provides type-safe parsing and detailed error messages.
 */

import { z } from 'zod';
import type { RpcConfig, ProviderConfig, Network, ProviderType, ApiVersion } from '../types';

// ============================================================================
// Base Schemas
// ============================================================================

/**
 * Network schema
 */
export const NetworkSchema = z.enum(['testnet', 'mainnet']);

/**
 * Provider type schema
 */
export const ProviderTypeSchema = z.enum([
    'chainstack',
    'quicknode',
    'toncenter',
    'orbs',
    'onfinality',
    'ankr',
    'getblock',
    'tatum',
    'tonhub',
    'custom',
]);

/**
 * API version schema
 */
export const ApiVersionSchema = z.enum(['v2', 'v3', 'v4']);

// ============================================================================
// Provider Schemas
// ============================================================================

/**
 * Provider endpoints schema
 */
export const ProviderEndpointsSchema = z.object({
    v2: z.string().url().optional(),
    v3: z.string().url().optional(),
    v4: z.string().url().optional(),
    ws: z.string().url().optional(),
}).refine(
    (data) => data.v2 || data.v3 || data.v4,
    { message: 'At least one endpoint (v2, v3, or v4) must be provided' }
);

/**
 * Single provider configuration schema
 */
export const ProviderConfigSchema = z.object({
    name: z.string().min(1, 'Provider name is required'),
    type: ProviderTypeSchema,
    network: NetworkSchema,
    endpoints: ProviderEndpointsSchema,
    keyEnvVar: z.string().optional(),
    apiKeyEnvVar: z.string().optional(),
    rps: z.number().int().positive().default(1),
    priority: z.number().int().nonnegative().default(10),
    enabled: z.boolean().default(true),
    isDynamic: z.boolean().optional().default(false),
    browserCompatible: z.boolean().optional(),
    description: z.string().optional(),
});

/**
 * Network defaults schema
 */
export const NetworkDefaultsSchema = z.object({
    testnet: z.array(z.string()).default([]),
    mainnet: z.array(z.string()).default([]),
});

/**
 * Complete RPC configuration schema
 */
export const RpcConfigSchema = z.object({
    $schema: z.string().optional(),
    version: z.string().default('1.0'),
    providers: z.record(z.string(), ProviderConfigSchema),
    defaults: NetworkDefaultsSchema,
}).refine(
    (data) => {
        // Validate that default provider IDs exist
        const providerIds = Object.keys(data.providers);
        const allDefaults = [...data.defaults.testnet, ...data.defaults.mainnet];
        const invalidIds = allDefaults.filter((id) => !providerIds.includes(id));
        return invalidIds.length === 0;
    },
    {
        message: 'Default provider IDs must reference existing providers',
    }
);

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Parse and validate RPC configuration
 * @param data - Raw configuration data
 * @returns Validated RpcConfig
 * @throws ConfigError on validation failure
 */
export function parseRpcConfig(data: unknown): RpcConfig {
    const result = RpcConfigSchema.safeParse(data);

    if (!result.success) {
        const errors = result.error.errors.map((e) => {
            const path = e.path.join('.');
            return `  - ${path}: ${e.message}`;
        }).join('\n');
        throw new Error(`Invalid rpc.json configuration:\n${errors}`);
    }

    return result.data as RpcConfig;
}

/**
 * Validate a single provider configuration
 * @param id - Provider ID
 * @param data - Provider configuration data
 * @returns Validated ProviderConfig
 */
export function parseProviderConfig(id: string, data: unknown): ProviderConfig {
    const result = ProviderConfigSchema.safeParse(data);

    if (!result.success) {
        const errors = result.error.errors.map((e) => {
            const path = e.path.join('.');
            return `${path}: ${e.message}`;
        }).join(', ');
        throw new Error(`Invalid provider "${id}": ${errors}`);
    }

    return result.data as ProviderConfig;
}

/**
 * Create a minimal valid RpcConfig for testing
 */
export function createEmptyConfig(): RpcConfig {
    return {
        version: '1.0',
        providers: {},
        defaults: {
            testnet: [],
            mainnet: [],
        },
    };
}

/**
 * Merge two RPC configurations (useful for defaults + user config)
 * @param base - Base configuration
 * @param override - Override configuration
 * @returns Merged configuration
 */
export function mergeConfigs(base: RpcConfig, override: Partial<RpcConfig>): RpcConfig {
    return {
        ...base,
        ...override,
        providers: {
            ...base.providers,
            ...(override.providers || {}),
        },
        defaults: {
            testnet: override.defaults?.testnet || base.defaults.testnet,
            mainnet: override.defaults?.mainnet || base.defaults.mainnet,
        },
    };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for Network
 */
export function isNetwork(value: unknown): value is Network {
    return value === 'testnet' || value === 'mainnet';
}

/**
 * Type guard for ProviderType
 */
export function isProviderType(value: unknown): value is ProviderType {
    const types: ProviderType[] = [
        'chainstack', 'quicknode', 'toncenter', 'orbs',
        'onfinality', 'ankr', 'getblock', 'tatum', 'tonhub', 'custom',
    ];
    return typeof value === 'string' && types.includes(value as ProviderType);
}

/**
 * Type guard for ApiVersion
 */
export function isApiVersion(value: unknown): value is ApiVersion {
    return value === 'v2' || value === 'v3' || value === 'v4';
}
