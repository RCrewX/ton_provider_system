/**
 * Unified Provider System - OnFinality Provider
 *
 * OnFinality-specific implementation.
 * Documentation: https://documentation.onfinality.io/support/ton
 *
 * Endpoint format: https://ton-{network}.api.onfinality.io/public or /rpc
 * API key: Optional, in apikey header (preferred) or query params
 */

import { BaseProvider } from './base';
import type { ResolvedProvider } from '../types';

export class OnFinalityProvider extends BaseProvider {
    constructor(provider: ResolvedProvider) {
        super(provider);
    }

    normalizeEndpoint(endpoint: string): string {
        let normalized = endpoint.trim();

        // Remove trailing slash
        if (normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
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
                    // Use /rpc if API key exists, /public if not
                    if (this.provider.apiKey) {
                        return baseUrl.replace(/\/?$/, '/rpc');
                    }
                    // No API key, use /public
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

        return normalized;
    }

    buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        // OnFinality supports API key in header (preferred) or query params
        // Use header method to avoid query string issues
        if (this.provider.apiKey) {
            headers['apikey'] = this.provider.apiKey;
        }

        return headers;
    }

    parseResponse<T = unknown>(data: unknown): T {
        // OnFinality may return backend errors in non-JSON format
        if (typeof data === 'string') {
            if (data.includes('Backend error') || data.includes('backend error')) {
                throw new Error(`OnFinality backend error: ${data}`);
            }
        }

        return super.parseResponse<T>(data);
    }
}
