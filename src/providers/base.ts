/**
 * Unified Provider System - Base Provider
 *
 * Base class for provider-specific implementations.
 * All provider types extend this class to provide provider-specific behavior.
 */

import type { ResolvedProvider, MasterchainInfo } from '../types';

/**
 * Base provider class that all provider-specific implementations extend.
 * Provides common functionality and defines the interface for provider-specific behavior.
 */
export abstract class BaseProvider {
    protected provider: ResolvedProvider;

    constructor(provider: ResolvedProvider) {
        this.provider = provider;
    }

    /**
     * Get the provider instance
     */
    getProvider(): ResolvedProvider {
        return this.provider;
    }

    /**
     * Normalize endpoint URL for this provider type.
     * Each provider may have different endpoint format requirements.
     */
    abstract normalizeEndpoint(endpoint: string): string;

    /**
     * Build HTTP headers for requests to this provider.
     * Handles provider-specific authentication (API keys in headers, etc.)
     */
    abstract buildHeaders(): Record<string, string>;

    /**
     * Build a JSON-RPC request body.
     * Most providers use standard JSON-RPC 2.0, but some may need modifications.
     */
    buildRequest(method: string, params: Record<string, unknown> = {}): {
        id: string;
        jsonrpc: string;
        method: string;
        params: Record<string, unknown>;
    } {
        return {
            id: '1',
            jsonrpc: '2.0',
            method,
            params,
        };
    }

    /**
     * Parse response from provider.
     * Handles provider-specific response formats.
     */
    parseResponse<T = unknown>(data: unknown): T {
        if (data && typeof data === 'object') {
            const dataObj = data as Record<string, unknown>;

            // Handle wrapped response { ok: true, result: ... } (GetBlock, some providers)
            if ('ok' in dataObj) {
                if (!dataObj.ok) {
                    const error = (dataObj as { error?: string }).error;
                    throw new Error(error || 'API returned ok=false');
                }
                const result = (dataObj as { result?: unknown }).result;
                return (result || dataObj) as T;
            }

            // Handle JSON-RPC response { result: ... } (standard JSON-RPC)
            if ('result' in dataObj) {
                return (dataObj as { result: unknown }).result as T;
            }

            // Handle direct response (some providers return data directly)
            if ('last' in dataObj || '@type' in dataObj) {
                return dataObj as T;
            }

            // Handle error response { error: ... }
            if ('error' in dataObj) {
                const errorObj = dataObj.error as { message?: string; code?: string } | string;
                const errorMsg =
                    typeof errorObj === 'string'
                        ? errorObj
                        : errorObj?.message || errorObj?.code || String(errorObj);
                throw new Error(`API error: ${errorMsg}`);
            }
        }

        // Unknown format, return as-is
        return data as T;
    }

    /**
     * Parse masterchain info from response.
     * Validates the response structure and extracts seqno.
     */
    parseMasterchainInfo(data: unknown): MasterchainInfo {
        const info = this.parseResponse<MasterchainInfo>(data);

        // Validate response structure
        if (!info || typeof info !== 'object') {
            throw new Error('Invalid response structure');
        }

        // Validate seqno exists and is valid (blocks start from 1)
        const infoObj = info as { last?: { seqno?: number } };
        const seqno = infoObj.last?.seqno;
        if (seqno === undefined || seqno === null || seqno <= 0 || !Number.isInteger(seqno)) {
            throw new Error(`Invalid seqno: ${seqno} (must be positive integer)`);
        }

        return info;
    }

    /**
     * Validate provider configuration.
     * Checks if required API keys are present, etc.
     */
    validateConfig(): { valid: boolean; error?: string } {
        // Base implementation: no validation needed
        // Subclasses can override for provider-specific requirements
        return { valid: true };
    }

    /**
     * Get the normalized endpoint for this provider.
     */
    getNormalizedEndpoint(): string {
        return this.normalizeEndpoint(this.provider.endpointV2);
    }

    /**
     * Check if this provider requires an API key.
     */
    requiresApiKey(): boolean {
        return false; // Base implementation: no API key required
        // Subclasses can override
    }

    /**
     * Check if API key is present (if required).
     */
    hasApiKey(): boolean {
        return !!this.provider.apiKey;
    }
}
