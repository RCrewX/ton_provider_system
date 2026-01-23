/**
 * Unified Provider System - TON Center Provider
 *
 * TON Center-specific implementation.
 * Documentation: https://toncenter.com/api/v2/
 *
 * Endpoint format: https://{testnet.}toncenter.com/api/v2/jsonRPC
 * API key: Optional, passed to TonClient (not in header for HTTP requests)
 */

import { BaseProvider } from './base';
import type { ResolvedProvider } from '../types';

export class TonCenterProvider extends BaseProvider {
    constructor(provider: ResolvedProvider) {
        super(provider);
    }

    normalizeEndpoint(endpoint: string): string {
        let normalized = endpoint.trim();

        // Remove trailing slash
        if (normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
        }

        // Already has /jsonRPC suffix
        if (normalized.toLowerCase().endsWith('/jsonrpc')) {
            return normalized;
        }

        // TON Center format: .../api/v2 -> .../api/v2/jsonRPC
        if (normalized.endsWith('/api/v2')) {
            return normalized + '/jsonRPC';
        }

        // For v3 endpoints, convert to v2
        if (normalized.endsWith('/api/v3')) {
            return normalized.replace('/api/v3', '/api/v2/jsonRPC');
        }

        return normalized;
    }

    buildHeaders(): Record<string, string> {
        // TON Center API key is passed to TonClient, not in HTTP headers
        // For direct HTTP requests, API key is optional
        return {
            'Content-Type': 'application/json',
        };
    }

    // TON Center API key is optional (1 RPS without key, 10 RPS with key)
    requiresApiKey(): boolean {
        return false;
    }
}
