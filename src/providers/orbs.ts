/**
 * Unified Provider System - Orbs Provider
 *
 * Orbs (TON Access) specific implementation.
 * Documentation: https://github.com/orbs-network/ton-access
 *
 * Endpoint format: Dynamic discovery via @orbs-network/ton-access
 * API key: Not required (decentralized gateway)
 */

import { BaseProvider } from './base';
import type { ResolvedProvider } from '../types';

export class OrbsProvider extends BaseProvider {
    constructor(provider: ResolvedProvider) {
        super(provider);
    }

    normalizeEndpoint(endpoint: string): string {
        // Orbs uses dynamic endpoint discovery
        // The endpoint from config is just a fallback
        // Real endpoint is discovered via @orbs-network/ton-access
        let normalized = endpoint.trim();

        // Remove trailing slash
        if (normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
        }

        // Orbs endpoints are already in correct format
        // They typically end with /api/v2
        if (normalized.endsWith('/api/v2')) {
            return normalized;
        }

        return normalized;
    }

    buildHeaders(): Record<string, string> {
        // Orbs doesn't require API keys
        return {
            'Content-Type': 'application/json',
        };
    }

    /**
     * Get dynamic endpoint from Orbs TON Access.
     * This should be called before making requests.
     */
    async getDynamicEndpoint(): Promise<string> {
        if (!this.provider.isDynamic) {
            return this.normalizeEndpoint(this.provider.endpointV2);
        }

        try {
            const { getHttpEndpoint } = await import('@orbs-network/ton-access');
            const endpoint = await getHttpEndpoint({ network: this.provider.network });
            return this.normalizeEndpoint(endpoint);
        } catch (error: any) {
            // Fallback to static endpoint if discovery fails
            return this.normalizeEndpoint(this.provider.endpointV2);
        }
    }

    requiresApiKey(): boolean {
        return false;
    }
}
