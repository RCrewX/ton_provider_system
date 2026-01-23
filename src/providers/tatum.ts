/**
 * Unified Provider System - Tatum Provider
 *
 * Tatum-specific implementation.
 * Documentation: https://docs.tatum.io/reference/rpc-ton
 *
 * Endpoint format: https://ton-{network}.gateway.tatum.io/jsonRPC
 * API key: Required in x-api-key header
 */

import { BaseProvider } from './base';
import type { ResolvedProvider } from '../types';

export class TatumProvider extends BaseProvider {
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

        // Tatum gateway URLs - need /jsonRPC appended
        // Format: https://ton-testnet.gateway.tatum.io -> .../jsonRPC
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

        return normalized;
    }

    buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        // Tatum requires API key in x-api-key header
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
                error: 'Tatum provider requires API key (set TATUM_API_KEY_TESTNET or TATUM_API_KEY_MAINNET)',
            };
        }
        return { valid: true };
    }
}
