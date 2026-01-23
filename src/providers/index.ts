/**
 * Unified Provider System - Provider Factory
 *
 * Factory for creating provider-specific implementations.
 */

import type { ResolvedProvider } from '../types';
import { BaseProvider } from './base';
import { ChainstackProvider } from './chainstack';
import { TatumProvider } from './tatum';
import { OnFinalityProvider } from './onfinality';
import { QuickNodeProvider } from './quicknode';
import { GetBlockProvider } from './getblock';
import { TonCenterProvider } from './toncenter';
import { OrbsProvider } from './orbs';

/**
 * Generic provider for unknown/custom provider types.
 * Uses default behavior from BaseProvider.
 */
class GenericProvider extends BaseProvider {
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

        // Default: try to append /jsonRPC if it looks like a base URL
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

    buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        // If API key is available, try to use it (generic approach)
        if (this.provider.apiKey) {
            // Try common header names
            headers['x-api-key'] = this.provider.apiKey;
        }

        return headers;
    }
}

/**
 * Create a provider-specific implementation for the given provider.
 *
 * @param provider - Resolved provider configuration
 * @returns Provider-specific implementation instance
 */
export function createProvider(provider: ResolvedProvider): BaseProvider {
    switch (provider.type) {
        case 'chainstack':
            return new ChainstackProvider(provider);
        case 'tatum':
            return new TatumProvider(provider);
        case 'onfinality':
            return new OnFinalityProvider(provider);
        case 'quicknode':
            return new QuickNodeProvider(provider);
        case 'getblock':
            return new GetBlockProvider(provider);
        case 'toncenter':
            return new TonCenterProvider(provider);
        case 'orbs':
            return new OrbsProvider(provider);
        case 'custom':
            return new GenericProvider(provider);
        default:
            // Unknown provider type, use generic implementation
            return new GenericProvider(provider);
    }
}

// Export all provider classes for advanced usage
export {
    BaseProvider,
    ChainstackProvider,
    TatumProvider,
    OnFinalityProvider,
    QuickNodeProvider,
    GetBlockProvider,
    TonCenterProvider,
    OrbsProvider,
    GenericProvider,
};
