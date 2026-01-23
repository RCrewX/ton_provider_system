/**
 * Unified Provider System - OnFinality Provider
 *
 * OnFinality-specific implementation.
 * Documentation: https://documentation.onfinality.io/support/ton
 *
 * Endpoint format: https://ton-{network}.api.onfinality.io/public or /rpc
 * API key: Required for /rpc endpoint, passed as query parameter ?apikey=YOUR_API_KEY
 * 
 * IMPORTANT: OnFinality uses query parameters for API key authentication, NOT headers.
 * The API key must be included in the URL as ?apikey=YOUR_API_KEY
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
        // Format: https://ton-testnet.api.onfinality.io/public or /rpc?apikey=KEY
        // CRITICAL: OnFinality requires API key in query params, NOT headers
        if (normalized.includes('onfinality.io')) {
            try {
                const url = new URL(normalized);
                const hasQueryParams = normalized.includes('?');
                const queryString = hasQueryParams ? normalized.split('?')[1] : '';
                const hasApiKeyInQuery = queryString.includes('apikey=');
                
                // If pathname is empty or just '/', determine correct path
                if (!url.pathname || url.pathname === '/') {
                    // Use /rpc if API key exists, /public if not
                    if (this.provider.apiKey) {
                        const baseUrl = normalized.split('?')[0];
                        // If apikey already in query, preserve it; otherwise add it
                        if (hasApiKeyInQuery) {
                            return normalized.replace(/\/?$/, '/rpc');
                        }
                        // Add apikey to query params
                        if (hasQueryParams) {
                            return `${baseUrl.replace(/\/?$/, '/rpc')}?${queryString}&apikey=${encodeURIComponent(this.provider.apiKey)}`;
                        }
                        return `${baseUrl.replace(/\/?$/, '/rpc')}?apikey=${encodeURIComponent(this.provider.apiKey)}`;
                    }
                    // No API key, use /public (remove query params if present)
                    const baseUrl = normalized.split('?')[0];
                    return baseUrl.replace(/\/?$/, '/public');
                }

                // If pathname is /rpc or /public, preserve it
                if (url.pathname === '/rpc' || url.pathname === '/public') {
                    // For /rpc, ensure API key is in query params
                    if (url.pathname === '/rpc') {
                        if (hasApiKeyInQuery) {
                            return normalized; // Already has apikey, return as-is
                        }
                        if (this.provider.apiKey) {
                            const baseUrl = normalized.split('?')[0];
                            if (hasQueryParams) {
                                return `${baseUrl}?${queryString}&apikey=${encodeURIComponent(this.provider.apiKey)}`;
                            }
                            return `${baseUrl}?apikey=${encodeURIComponent(this.provider.apiKey)}`;
                        }
                        // No API key but /rpc path - this is invalid, but return as-is
                        return normalized;
                    }
                    // For /public, remove query params (no API key needed)
                    if (url.pathname === '/public') {
                        return normalized.split('?')[0];
                    }
                    return normalized;
                }

                // If pathname exists but is not /rpc or /public, preserve it and query params
                return normalized;
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
                // Preserve query params if present
                return normalized;
            }
        }

        return normalized;
    }

    buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        // OnFinality uses query parameters for API key authentication, NOT headers
        // The API key is already included in the URL by normalizeEndpoint()
        // Do NOT add apikey header - OnFinality doesn't support it

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
