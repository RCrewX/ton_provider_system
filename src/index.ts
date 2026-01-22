/**
 * Unified Provider System
 *
 * A bullet-proof TON RPC provider management system for:
 * - Smart contracts development (ton_game)
 * - Web applications (ton_site)
 * - Telegram bots (new_tg_bot)
 *
 * Features:
 * - Multi-provider support with automatic failover
 * - Health checking with latency and block height monitoring
 * - Token bucket rate limiting per provider
 * - Automatic best provider selection
 * - Custom endpoint override
 * - Environment-based configuration
 *
 * Quick Start (Node.js):
 * ```typescript
 * import { ProviderManager, getTonClient } from './provider_system';
 *
 * const pm = ProviderManager.getInstance();
 * await pm.init('testnet');
 *
 * const client = await getTonClient(pm);
 * // Use client for blockchain operations
 * ```
 *
 * Quick Start (Browser/React):
 * ```typescript
 * import { ProviderManager, BrowserAdapter } from './provider_system';
 *
 * const pm = new ProviderManager({ adapter: 'browser' });
 * await pm.init(network);
 *
 * const adapter = new BrowserAdapter(pm);
 * const balance = await adapter.getAddressBalance(address);
 * ```
 *
 * @module provider_system
 */

// ============================================================================
// Types
// ============================================================================

export type {
    // Network and API types
    Network,
    ApiVersion,
    ProviderType,

    // Configuration types
    ProviderConfig,
    ProviderEndpoints,
    NetworkDefaults,
    RpcConfig,

    // Runtime types
    ResolvedProvider,
    ProviderStatus,
    ProviderHealthResult,
    ProviderState,

    // Rate limiting types
    RateLimitConfig,
    RateLimitState,

    // Manager types
    ProviderManagerOptions,
    ProviderManagerState,
    StateListener,

    // API types
    MasterchainInfo,
    TonApiResponse,

    // Utility types
    Logger,
} from './types';

// Error classes
export {
    TimeoutError,
    ProviderError,
    RateLimitError,
    ConfigError,
} from './types';

// ============================================================================
// Configuration
// ============================================================================

export {
    // Schema validation
    parseRpcConfig,
    parseProviderConfig,
    createEmptyConfig,
    mergeConfigs,
    NetworkSchema,
    ProviderTypeSchema,
    ApiVersionSchema,
    RpcConfigSchema,
    ProviderConfigSchema,

    // Type guards
    isNetwork,
    isProviderType,
    isApiVersion,

    // Config parsing
    loadConfig,
    loadBuiltinConfig,
    loadConfigFromUrl,
    loadConfigFromData,
    getEnvVar,
    resolveKeyPlaceholder,
    resolveEndpoints,
    resolveProvider,
    resolveAllProviders,
    getProvidersForNetwork,
    getDefaultProvidersForNetwork,
    mergeWithDefaults,
    createDefaultConfig,
    DEFAULT_PROVIDERS,
} from './config';

// ============================================================================
// Core Components
// ============================================================================

// Provider Registry
export {
    ProviderRegistry,
    createRegistry,
    createRegistryFromFile, // @deprecated - use createRegistry()
    createDefaultRegistry,
    createRegistryFromData,
} from './core/registry';

// Health Checker
export {
    HealthChecker,
    createHealthChecker,
    type HealthCheckConfig,
} from './core/healthChecker';

// Rate Limiter
export {
    TokenBucketRateLimiter,
    RateLimiterManager,
    createRateLimiter,
    createRateLimiterManager,
    getRateLimitForType,
    DEFAULT_RATE_LIMIT,
    CHAINSTACK_RATE_LIMIT,
    QUICKNODE_RATE_LIMIT,
    ORBS_RATE_LIMIT,
} from './core/rateLimiter';

// Provider Selector
export {
    ProviderSelector,
    createSelector,
    type SelectionConfig,
} from './core/selector';

// Provider Manager
export {
    ProviderManager,
    createProviderManager,
    getProviderManager,
} from './core/manager';

// ============================================================================
// Adapters
// ============================================================================

// Node.js Adapter
export {
    NodeAdapter,
    createNodeAdapter,
    getTonClient,
    getTonClientWithRateLimit,
    getTonClientForNetwork,
    resetNodeAdapter,
} from './adapters/node';

// Browser Adapter
export {
    BrowserAdapter,
    createBrowserAdapter,
    createBrowserAdapterForNetwork,
} from './adapters/browser';

// ============================================================================
// Utilities
// ============================================================================

export {
    // Endpoint utilities
    normalizeV2Endpoint,
    toV2Base,
    toV3Base,
    getBaseUrl,
    isChainstackUrl,
    isQuickNodeUrl,
    isTonCenterUrl,
    isOrbsUrl,
    buildRestUrl,
    buildGetAddressStateUrl,
    buildGetAddressBalanceUrl,
    buildGetAddressInfoUrl,
    detectNetworkFromEndpoint,
    isValidHttpUrl,
    isValidWsUrl,

    // Timeout utilities
    withTimeout,
    withTimeoutFn,
    createTimeoutController,
    fetchWithTimeout,
    withRetry,
    withTimeoutAndRetry,
    sleep,
    isTimeoutError,
    isRateLimitError,
    DEFAULT_PROVIDER_TIMEOUT_MS,
    DEFAULT_CONTRACT_TIMEOUT_MS,
    DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
    type RetryOptions,
} from './utils';
