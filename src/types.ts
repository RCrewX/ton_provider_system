/**
 * Unified Provider System - Type Definitions
 *
 * Core types for the TON RPC provider management system.
 * These types are used across all components of the provider system.
 */

// ============================================================================
// Network Types
// ============================================================================

/**
 * Supported TON networks
 */
export type Network = 'testnet' | 'mainnet';

/**
 * API version types supported by TON providers
 * - v2: TON Center HTTP API v2 (JSON-RPC style) - most common
 * - v4: TON API v4 (ton-community/ton-api-v4) - different format
 */
export type ApiVersion = 'v2' | 'v3' | 'v4';

// ============================================================================
// Provider Configuration Types (from rpc.json)
// ============================================================================

/**
 * Provider type identifier
 */
export type ProviderType =
    | 'chainstack'
    | 'quicknode'
    | 'toncenter'
    | 'orbs'
    | 'onfinality'
    | 'ankr'
    | 'getblock'
    | 'tatum'
    | 'tonhub'
    | 'custom';

/**
 * Provider endpoint configuration
 */
export interface ProviderEndpoints {
    /** API v2 endpoint URL (may contain {key} placeholder) */
    v2?: string;
    /** API v3 endpoint URL (may contain {key} placeholder) */
    v3?: string;
    /** API v4 endpoint URL */
    v4?: string;
    /** WebSocket endpoint URL */
    ws?: string;
}

/**
 * Single provider definition from rpc.json config
 */
export interface ProviderConfig {
    /** Human-readable provider name */
    name: string;
    /** Provider type for special handling */
    type: ProviderType;
    /** Network this provider serves */
    network: Network;
    /** Endpoint URLs */
    endpoints: ProviderEndpoints;
    /** Environment variable name for API key (replaces {key} in endpoints) */
    keyEnvVar?: string;
    /** Environment variable name for separate API key header */
    apiKeyEnvVar?: string;
    /** Requests per second limit */
    rps: number;
    /** Priority for selection (lower = higher priority) */
    priority: number;
    /** Whether this provider is enabled */
    enabled: boolean;
    /** Whether this provider requires dynamic endpoint discovery (e.g., Orbs) */
    isDynamic?: boolean;
    /** Optional description or notes */
    description?: string;
}

/**
 * Default provider order per network
 */
export interface NetworkDefaults {
    testnet: string[];
    mainnet: string[];
}

/**
 * Complete rpc.json configuration file structure
 */
export interface RpcConfig {
    /** JSON Schema reference (optional) */
    $schema?: string;
    /** Config version */
    version: string;
    /** Provider definitions keyed by unique ID */
    providers: Record<string, ProviderConfig>;
    /** Default provider order per network */
    defaults: NetworkDefaults;
}

// ============================================================================
// Runtime Provider Types
// ============================================================================

/**
 * Provider health status
 */
export type ProviderStatus = 'available' | 'degraded' | 'offline' | 'stale' | 'untested' | 'testing';

/**
 * Resolved provider with actual endpoint URLs (env vars replaced)
 */
export interface ResolvedProvider {
    /** Unique provider ID */
    id: string;
    /** Human-readable name */
    name: string;
    /** Provider type */
    type: ProviderType;
    /** Network */
    network: Network;
    /** Resolved v2 endpoint URL (ready to use) */
    endpointV2: string;
    /** Resolved v3 endpoint URL (if available) */
    endpointV3?: string;
    /** Resolved v4 endpoint URL (if available) */
    endpointV4?: string;
    /** Resolved WebSocket URL (if available) */
    endpointWs?: string;
    /** API key (if separate from URL) */
    apiKey?: string;
    /** Requests per second limit */
    rps: number;
    /** Priority (lower = higher priority) */
    priority: number;
    /** Whether dynamic discovery is needed */
    isDynamic: boolean;
}

/**
 * Provider health check result
 */
export interface ProviderHealthResult {
    /** Provider ID */
    id: string;
    /** Network */
    network: Network;
    /** Test success */
    success: boolean;
    /** Current status */
    status: ProviderStatus;
    /** Latency in milliseconds */
    latencyMs: number | null;
    /** Current masterchain seqno (block height) */
    seqno: number | null;
    /** Blocks behind the best provider (0 = up to date) */
    blocksBehind: number;
    /** Timestamp of last test */
    lastTested: Date | null;
    /** Cached endpoint URL */
    cachedEndpoint?: string;
    /** Error message if failed */
    error?: string;
}

/**
 * Provider state for runtime tracking
 */
export interface ProviderState {
    /** Provider ID */
    id: string;
    /** Current health result */
    health: ProviderHealthResult;
    /** Current rate limit state */
    rateLimit: RateLimitState;
}

// ============================================================================
// Rate Limiting Types
// ============================================================================

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
    /** Requests per second */
    rps: number;
    /** Burst size (max tokens) */
    burstSize: number;
    /** Minimum delay between requests in ms */
    minDelayMs: number;
    /** Backoff multiplier on 429 errors */
    backoffMultiplier: number;
    /** Maximum backoff delay in ms */
    maxBackoffMs: number;
}

/**
 * Rate limit state for a provider
 */
export interface RateLimitState {
    /** Available tokens */
    tokens: number;
    /** Last refill timestamp */
    lastRefill: number;
    /** Current backoff delay (0 = no backoff) */
    currentBackoff: number;
    /** Consecutive error count */
    consecutiveErrors: number;
    /** Whether a request is currently being processed */
    processing: boolean;
    /** Pending request resolvers */
    queueLength: number;
}

// ============================================================================
// Manager Types
// ============================================================================

/**
 * Provider manager configuration options
 */
export interface ProviderManagerOptions {
    /** @deprecated Unused - config is loaded from provider_system/rpc.json */
    configPath?: string;
    /** Adapter type: 'node' for Node.js, 'browser' for browser */
    adapter?: 'node' | 'browser';
    /** Whether to auto-initialize on first use */
    autoInit?: boolean;
    /** Request timeout in ms (default: 10000) */
    requestTimeoutMs?: number;
    /** Health check interval in ms (0 = disabled) */
    healthCheckIntervalMs?: number;
    /** Maximum blocks behind before marking as stale */
    maxBlocksBehind?: number;
    /** Custom logger (default: console) */
    logger?: Logger;
}

/**
 * Logger interface for custom logging
 */
export interface Logger {
    debug: (message: string, data?: Record<string, unknown>) => void;
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Provider manager state
 */
export interface ProviderManagerState {
    /** Current network */
    network: Network | null;
    /** Whether initialized */
    initialized: boolean;
    /** Whether testing is in progress */
    isTesting: boolean;
    /** All provider states */
    providers: Map<string, ProviderState>;
    /** Best provider ID per network */
    bestProviderByNetwork: Map<Network, string>;
    /** Manually selected provider ID (null = auto) */
    selectedProviderId: string | null;
    /** Whether auto-selection is enabled */
    autoSelect: boolean;
    /** Custom endpoint override */
    customEndpoint: string | null;
}

/**
 * State change listener
 */
export type StateListener = (state: ProviderManagerState) => void;

// ============================================================================
// API Response Types
// ============================================================================

/**
 * TON API getMasterchainInfo response
 */
export interface MasterchainInfo {
    /** Current masterchain block seqno */
    last: {
        seqno: number;
        workchain: number;
        shard: string;
        root_hash: string;
        file_hash: string;
    };
    /** State root hash */
    state_root_hash: string;
    /** Init block */
    init: {
        workchain: number;
        seqno: number;
        root_hash: string;
        file_hash: string;
    };
}

/**
 * Generic TON API response wrapper
 */
export interface TonApiResponse<T = unknown> {
    ok: boolean;
    result?: T;
    error?: string;
    code?: number;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Timeout error class
 */
export class TimeoutError extends Error {
    constructor(
        public readonly operation: string,
        public readonly timeoutMs: number,
        message?: string
    ) {
        super(message || `Operation "${operation}" timed out after ${timeoutMs}ms`);
        this.name = 'TimeoutError';
    }
}

/**
 * Provider error class
 */
export class ProviderError extends Error {
    constructor(
        public readonly providerId: string,
        public readonly operation: string,
        message: string,
        public readonly cause?: Error
    ) {
        super(`[${providerId}] ${operation}: ${message}`);
        this.name = 'ProviderError';
    }
}

/**
 * Rate limit error class
 */
export class RateLimitError extends Error {
    constructor(
        public readonly providerId: string,
        public readonly retryAfterMs?: number
    ) {
        super(`Provider ${providerId} rate limited${retryAfterMs ? `, retry after ${retryAfterMs}ms` : ''}`);
        this.name = 'RateLimitError';
    }
}

/**
 * Configuration error class
 */
export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}
