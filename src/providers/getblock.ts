/**
 * Unified Provider System - GetBlock Provider
 *
 * GetBlock-specific implementation.
 * Documentation: https://docs.getblock.io/api-reference/the-open-network-ton
 *
 * Endpoint format: https://go.getblock.io/{key}/jsonRPC
 * API key: Required in x-api-key header
 */

import { BaseProvider } from './base';
import type { ResolvedProvider } from '../types';

export class GetBlockProvider extends BaseProvider {
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

        // GetBlock: base URLs need /jsonRPC appended
        // Format: https://go.getblock.io/{key}/ -> .../jsonRPC
        if (normalized.includes('getblock.io')) {
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

        return normalized;
    }

    buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        // GetBlock requires API key in x-api-key header
        if (this.provider.apiKey) {
            headers['x-api-key'] = this.provider.apiKey;
        }

        return headers;
    }

    requiresApiKey(): boolean {
        return true;
    }

    validateConfig(): { valid: boolean; error?: string } {
        if (!this.provider.apiKey) {
            return {
                valid: false,
                error: 'GetBlock provider requires API key',
            };
        }
        return { valid: true };
    }
}
