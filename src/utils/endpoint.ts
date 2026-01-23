/**
 * Unified Provider System - Endpoint Utilities
 *
 * URL normalization and manipulation for TON RPC endpoints.
 */

import type { ResolvedProvider, ProviderType } from '../types';
import { createProvider } from '../providers';

// ============================================================================
// URL Normalization
// ============================================================================

/**
 * Normalize endpoint URL for TonClient v2 API using provider-specific implementation.
 * This is the preferred method when a ResolvedProvider is available.
 *
 * @param endpoint - Endpoint URL to normalize
 * @param provider - Resolved provider configuration (optional)
 * @returns Normalized endpoint URL
 */
export function normalizeV2Endpoint(
    endpoint: string,
    provider?: ResolvedProvider
): string {
    // If provider is available, use provider-specific implementation
    if (provider) {
        const providerImpl = createProvider(provider);
        return providerImpl.normalizeEndpoint(endpoint);
    }

    // Fallback: detect provider type from URL and use appropriate normalization
    return normalizeV2EndpointFallback(endpoint);
}

/**
 * Fallback normalization when provider type is unknown.
 * Tries to detect provider type from URL and apply appropriate normalization.
 *
 * @param endpoint - Endpoint URL to normalize
 * @returns Normalized endpoint URL
 */
function normalizeV2EndpointFallback(endpoint: string): string {
    let normalized = endpoint.trim();

    // Remove trailing slash
    if (normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }

    // Already has /jsonRPC suffix (case-insensitive check)
    if (normalized.toLowerCase().endsWith('/jsonrpc')) {
        return normalized;
    }

    // Tatum gateway URLs - need /jsonRPC appended
    // Format: https://ton-testnet.gateway.tatum.io -> https://ton-testnet.gateway.tatum.io/jsonRPC
    if (normalized.includes('gateway.tatum.io')) {
        try {
            const url = new URL(normalized);
            // If pathname is empty or just '/', append /jsonRPC
            if (!url.pathname || url.pathname === '/') {
                return normalized + '/jsonRPC';
            }
            // If pathname doesn't end with /jsonRPC, append it
            if (!url.pathname.toLowerCase().endsWith('/jsonrpc')) {
                return normalized + '/jsonRPC';
            }
        } catch {
            // Not a valid URL, try simple append
            return normalized + '/jsonRPC';
        }
    }

    // OnFinality URLs - use /public for public access, /rpc for API key access
    // Format: https://ton-testnet.api.onfinality.io/public or /rpc
    // Note: API key should be passed in 'apikey' header, not query params
    if (normalized.includes('onfinality.io')) {
        try {
            const url = new URL(normalized);
            // Remove query params (API key goes in header, not URL)
            const baseUrl = normalized.split('?')[0];
            
            // If pathname is empty or just '/', determine correct path
            if (!url.pathname || url.pathname === '/') {
                // Check if API key exists in query (for backward compatibility)
                // But we'll use /rpc if key exists, /public if not
                const apikey = url.searchParams.get('apikey');
                if (apikey && apikey !== '{key}' && apikey.length > 0) {
                    // API key is set, use /rpc (key will be in header)
                    return baseUrl.replace(/\/?$/, '/rpc');
                }
                // No API key or placeholder not resolved, use /public
                return baseUrl.replace(/\/?$/, '/public');
            }
            // If pathname is /rpc or /public, use it (remove query params)
            if (url.pathname === '/rpc' || url.pathname === '/public') {
                return baseUrl;
            }
            // If pathname exists but is not /rpc or /public, preserve it
            return baseUrl;
        } catch {
            // Not a valid URL, check if it contains unresolved placeholder
            if (normalized.includes('{key}')) {
                // Key not resolved, use /public (remove query string)
                return normalized.split('?')[0].replace(/\/?$/, '/public');
            }
            // Try to append /public as fallback
            if (!normalized.includes('/rpc') && !normalized.includes('/public')) {
                return normalized.split('?')[0] + '/public';
            }
            return normalized.split('?')[0];
        }
    }

    // Check if this is a v2 API endpoint that needs /jsonRPC suffix
    // Chainstack format: https://ton-testnet.core.chainstack.com/KEY/api/v2
    // Toncenter format: https://testnet.toncenter.com/api/v2
    if (normalized.endsWith('/api/v2')) {
        return normalized + '/jsonRPC';
    }

    // For v3 endpoints, convert to v2 base and add /jsonRPC
    if (normalized.endsWith('/api/v3')) {
        return normalized.replace('/api/v3', '/api/v2/jsonRPC');
    }

    // QuickNode and GetBlock: base URLs need /jsonRPC appended
    // QuickNode: https://{key}.ton-mainnet.quiknode.pro/ -> .../jsonRPC
    // GetBlock: https://go.getblock.io/{key}/ -> .../jsonRPC
    if (normalized.includes('quiknode.pro') || normalized.includes('getblock.io')) {
        try {
            const url = new URL(normalized);
            if (!url.pathname || url.pathname === '/') {
                return normalized + '/jsonRPC';
            }
            // If pathname exists but doesn't end with /jsonRPC, append it
            if (!url.pathname.toLowerCase().endsWith('/jsonrpc')) {
                return normalized + '/jsonRPC';
            }
        } catch {
            // Not a valid URL, try simple append
            return normalized + '/jsonRPC';
        }
    }

    // If it looks like a base URL without path, append /jsonRPC
    try {
        const url = new URL(normalized);
        if (!url.pathname || url.pathname === '/') {
            return normalized + '/jsonRPC';
        }
    } catch {
        // Not a valid URL, return as-is
    }

    return normalized;
}

/**
 * Detect provider type from endpoint URL.
 * Used for fallback normalization when provider is not available.
 */
function detectProviderTypeFromUrl(url: string): ProviderType | null {
    const lower = url.toLowerCase();

    if (lower.includes('chainstack.com')) return 'chainstack';
    if (lower.includes('gateway.tatum.io')) return 'tatum';
    if (lower.includes('onfinality.io')) return 'onfinality';
    if (lower.includes('quiknode.pro')) return 'quicknode';
    if (lower.includes('getblock.io')) return 'getblock';
    if (lower.includes('toncenter.com')) return 'toncenter';
    if (lower.includes('orbs.network') || lower.includes('ton-access')) return 'orbs';

    return null;
}

/**
 * Convert any endpoint to v2 base URL (without /jsonRPC suffix).
 */
export function toV2Base(endpoint: string): string {
    let normalized = endpoint.trim();

    // Remove trailing slash
    if (normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }

    // Remove /jsonRPC suffix (case-insensitive)
    if (normalized.toLowerCase().endsWith('/jsonrpc')) {
        normalized = normalized.slice(0, -8);
    }

    // Convert v3 to v2
    normalized = normalized.replace(/\/api\/v3\b/, '/api/v2');

    // Ensure ends with /api/v2
    if (!normalized.endsWith('/api/v2')) {
        // Check if it already has /api/v2 somewhere
        if (normalized.includes('/api/v2')) {
            // Remove everything after /api/v2
            const idx = normalized.indexOf('/api/v2');
            normalized = normalized.slice(0, idx + 7);
        }
    }

    return normalized;
}

/**
 * Convert any endpoint to v3 base URL.
 */
export function toV3Base(endpoint: string): string {
    const normalized = toV2Base(endpoint);
    return normalized.replace('/api/v2', '/api/v3');
}

/**
 * Extract the base URL (protocol + host) from an endpoint.
 */
export function getBaseUrl(endpoint: string): string {
    try {
        const url = new URL(endpoint);
        return `${url.protocol}//${url.host}`;
    } catch {
        return endpoint;
    }
}

/**
 * Check if an endpoint is a Chainstack URL.
 */
export function isChainstackUrl(url: string): boolean {
    try {
        const parsed = new URL(url.trim());
        return parsed.hostname.includes('chainstack.com');
    } catch {
        return false;
    }
}

/**
 * Check if an endpoint is a QuickNode URL.
 */
export function isQuickNodeUrl(url: string): boolean {
    try {
        const parsed = new URL(url.trim());
        return parsed.hostname.includes('quiknode.pro');
    } catch {
        return false;
    }
}

/**
 * Check if an endpoint is a TonCenter URL.
 */
export function isTonCenterUrl(url: string): boolean {
    try {
        const parsed = new URL(url.trim());
        return parsed.hostname.includes('toncenter.com');
    } catch {
        return false;
    }
}

/**
 * Check if an endpoint is an Orbs URL.
 */
export function isOrbsUrl(url: string): boolean {
    try {
        const parsed = new URL(url.trim());
        return parsed.hostname.includes('orbs.network') || 
               parsed.hostname.includes('ton-access');
    } catch {
        return false;
    }
}

// ============================================================================
// URL Building
// ============================================================================

/**
 * Build a full endpoint URL for a specific API method (REST style).
 */
export function buildRestUrl(baseEndpoint: string, method: string): string {
    const base = toV2Base(baseEndpoint);
    return `${base}/${method}`;
}

/**
 * Build URL for getAddressState call.
 */
export function buildGetAddressStateUrl(baseEndpoint: string, address: string): string {
    const base = toV2Base(baseEndpoint);
    return `${base}/getAddressState?address=${encodeURIComponent(address)}`;
}

/**
 * Build URL for getAddressBalance call.
 */
export function buildGetAddressBalanceUrl(baseEndpoint: string, address: string): string {
    const base = toV2Base(baseEndpoint);
    return `${base}/getAddressBalance?address=${encodeURIComponent(address)}`;
}

/**
 * Build URL for getAddressInformation call.
 */
export function buildGetAddressInfoUrl(baseEndpoint: string, address: string): string {
    const base = toV2Base(baseEndpoint);
    return `${base}/getAddressInformation?address=${encodeURIComponent(address)}`;
}

// ============================================================================
// Network Detection
// ============================================================================

/**
 * Detect network from endpoint URL.
 */
export function detectNetworkFromEndpoint(endpoint: string): 'testnet' | 'mainnet' | null {
    const lower = endpoint.toLowerCase();

    if (
        lower.includes('testnet') ||
        lower.includes('test') ||
        lower.includes('sandbox')
    ) {
        return 'testnet';
    }

    if (
        lower.includes('mainnet') ||
        lower.includes('main') ||
        // TonCenter mainnet doesn't have 'mainnet' in URL
        (lower.includes('toncenter.com') && !lower.includes('testnet'))
    ) {
        return 'mainnet';
    }

    return null;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that a string is a valid HTTP(S) URL.
 */
export function isValidHttpUrl(str: string): boolean {
    try {
        const url = new URL(str);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Validate that a string is a valid WebSocket URL.
 */
export function isValidWsUrl(str: string): boolean {
    try {
        const url = new URL(str);
        return url.protocol === 'ws:' || url.protocol === 'wss:';
    } catch {
        return false;
    }
}
