/**
 * Unified Provider System - Chainstack Provider
 *
 * Chainstack-specific implementation.
 * Documentation: https://docs.chainstack.com/reference/getting-started-ton
 *
 * Endpoint format: https://ton-{network}.core.chainstack.com/{key}/api/v2/jsonRPC
 * API key: In URL path (not header)
 */

import { BaseProvider } from './base';
import type { ResolvedProvider } from '../types';

export class ChainstackProvider extends BaseProvider {
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

        // Chainstack format: .../api/v2 -> .../api/v2/jsonRPC
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
        return {
            'Content-Type': 'application/json',
        };
    }

    validateConfig(): { valid: boolean; error?: string } {
        // Chainstack API key is in URL path, not header
        // If {key} placeholder is not resolved, endpoint will be invalid
        if (this.provider.endpointV2.includes('{key}')) {
            return {
                valid: false,
                error: 'Chainstack API key not resolved in endpoint URL',
            };
        }
        return { valid: true };
    }
}
