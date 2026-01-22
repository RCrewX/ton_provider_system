/**
 * Unified Provider System - Endpoint Utilities
 *
 * URL normalization and manipulation for TON RPC endpoints.
 */

// ============================================================================
// URL Normalization
// ============================================================================

/**
 * Normalize endpoint URL for TonClient v2 API.
 * Ensures the endpoint has /jsonRPC suffix for JSON-RPC POST requests.
 *
 * Different providers have different endpoint formats:
 * - toncenter.com: POST to /api/v2/jsonRPC
 * - Chainstack: POST to /api/v2/jsonRPC (needs /jsonRPC suffix!)
 * - TON Access (orbs): Already returns correct JSON-RPC endpoint
 * - QuickNode: Usually needs /jsonRPC appended
 */
export function normalizeV2Endpoint(endpoint: string): string {
    let normalized = endpoint.trim();

    // Remove trailing slash
    if (normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }

    // Already has /jsonRPC suffix (case-insensitive check)
    if (normalized.toLowerCase().endsWith('/jsonrpc')) {
        return normalized;
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
    let normalized = toV2Base(endpoint);
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
