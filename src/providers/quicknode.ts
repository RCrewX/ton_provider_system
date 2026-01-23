/**
 * Unified Provider System - QuickNode Provider
 *
 * QuickNode-specific implementation.
 * Documentation: https://quicknode.com/docs/ton
 *
 * Endpoint format: https://{key}.ton-{network}.quiknode.pro/jsonRPC
 * API key: In subdomain (not header)
 */

import { BaseProvider } from './base';
import type { ResolvedProvider } from '../types';

export class QuickNodeProvider extends BaseProvider {
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

        // QuickNode: base URLs need /jsonRPC appended
        // Format: https://{key}.ton-mainnet.quiknode.pro/ -> .../jsonRPC
        if (normalized.includes('quiknode.pro')) {
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
        return {
            'Content-Type': 'application/json',
        };
    }

    validateConfig(): { valid: boolean; error?: string } {
        // QuickNode API key is in subdomain, not header
        // If {key} placeholder is not resolved, endpoint will be invalid
        if (this.provider.endpointV2.includes('{key}')) {
            return {
                valid: false,
                error: 'QuickNode API key not resolved in endpoint URL',
            };
        }
        return { valid: true };
    }
}
