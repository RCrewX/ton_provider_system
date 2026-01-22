/**
 * Unified Provider System - Browser Adapter
 *
 * Provides browser-compatible TON client functionality.
 * Designed for use in React/Next.js applications.
 */

import type { Network, ResolvedProvider, Logger, ProviderHealthResult } from '../types';
import { ProviderManager } from '../core/manager';
import { normalizeV2Endpoint, toV2Base } from '../utils/endpoint';

// ============================================================================
// Console Logger (default)
// ============================================================================

const consoleLogger: Logger = {
    debug: (msg, data) => console.debug(`[BrowserAdapter] ${msg}`, data || ''),
    info: (msg, data) => console.log(`[BrowserAdapter] ${msg}`, data || ''),
    warn: (msg, data) => console.warn(`[BrowserAdapter] ${msg}`, data || ''),
    error: (msg, data) => console.error(`[BrowserAdapter] ${msg}`, data || ''),
};

// ============================================================================
// Browser Adapter
// ============================================================================

/**
 * Browser Adapter for Provider System
 *
 * Provides fetch-based TON API access for browser environments.
 * Compatible with React, Next.js, and other browser frameworks.
 *
 * Note: TonClient from @ton/ton works in browser but requires polyfills.
 * This adapter provides a lighter alternative using fetch directly.
 */
export class BrowserAdapter {
    private manager: ProviderManager;
    private logger: Logger;

    constructor(manager: ProviderManager, logger?: Logger) {
        this.manager = manager;
        this.logger = logger || consoleLogger;
    }

    /**
     * Get current endpoint URL
     */
    async getEndpoint(): Promise<string> {
        return this.manager.getEndpoint();
    }

    /**
     * Get endpoint with rate limiting
     */
    async getEndpointWithRateLimit(timeoutMs?: number): Promise<string> {
        return this.manager.getEndpointWithRateLimit(timeoutMs);
    }

    // ========================================================================
    // JSON-RPC Methods
    // ========================================================================

    /**
     * Make a JSON-RPC call to the TON API
     */
    async jsonRpc<T = unknown>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs: number = 10000
    ): Promise<T> {
        const endpoint = await this.manager.getEndpoint();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: '1',
                    jsonrpc: '2.0',
                    method,
                    params,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const json = await response.json();
            const data = this.unwrapResponse(json);

            this.manager.reportSuccess();
            return data as T;
        } catch (error: any) {
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
                this.manager.reportError(timeoutError);
                throw timeoutError;
            }

            this.manager.reportError(error);
            throw error;
        }
    }

    // ========================================================================
    // REST API Methods
    // ========================================================================

    /**
     * Get address state
     */
    async getAddressState(
        address: string,
        timeoutMs: number = 10000
    ): Promise<'uninit' | 'active' | 'frozen'> {
        const endpoint = await this.manager.getEndpoint();
        const baseV2 = toV2Base(endpoint);
        const url = `${baseV2}/getAddressState?address=${encodeURIComponent(address)}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                headers: { accept: 'application/json' },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            const json = await response.json();
            const data = this.unwrapResponse(json);

            if (typeof data === 'string') {
                this.manager.reportSuccess();
                return data as 'uninit' | 'active' | 'frozen';
            }

            if (data && typeof data === 'object' && typeof data.state === 'string') {
                this.manager.reportSuccess();
                return data.state as 'uninit' | 'active' | 'frozen';
            }

            throw new Error('Unexpected response format');
        } catch (error: any) {
            clearTimeout(timeoutId);
            this.manager.reportError(error);
            throw error;
        }
    }

    /**
     * Get address balance
     */
    async getAddressBalance(
        address: string,
        timeoutMs: number = 10000
    ): Promise<bigint> {
        const endpoint = await this.manager.getEndpoint();
        const baseV2 = toV2Base(endpoint);
        const url = `${baseV2}/getAddressBalance?address=${encodeURIComponent(address)}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                headers: { accept: 'application/json' },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            const json = await response.json();
            const data = this.unwrapResponse(json);

            if (typeof data === 'string' || typeof data === 'number') {
                this.manager.reportSuccess();
                return BigInt(data);
            }

            if (data && typeof data === 'object' && data.balance !== undefined) {
                this.manager.reportSuccess();
                return BigInt(String(data.balance));
            }

            throw new Error('Unexpected response format');
        } catch (error: any) {
            clearTimeout(timeoutId);
            this.manager.reportError(error);
            throw error;
        }
    }

    /**
     * Get address information
     */
    async getAddressInfo(
        address: string,
        timeoutMs: number = 10000
    ): Promise<{
        state: 'uninit' | 'active' | 'frozen';
        balance: bigint;
        lastTransactionLt?: string;
        lastTransactionHash?: string;
    }> {
        const endpoint = await this.manager.getEndpoint();
        const baseV2 = toV2Base(endpoint);
        const url = `${baseV2}/getAddressInformation?address=${encodeURIComponent(address)}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                headers: { accept: 'application/json' },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            const json = await response.json();
            const data = this.unwrapResponse(json);

            this.manager.reportSuccess();

            return {
                state: data.state as 'uninit' | 'active' | 'frozen',
                balance: BigInt(String(data.balance || 0)),
                lastTransactionLt: data.last_transaction_id?.lt,
                lastTransactionHash: data.last_transaction_id?.hash,
            };
        } catch (error: any) {
            clearTimeout(timeoutId);
            this.manager.reportError(error);
            throw error;
        }
    }

    /**
     * Run get method
     */
    async runGetMethod(
        address: string,
        method: string,
        stack: unknown[] = [],
        timeoutMs: number = 15000
    ): Promise<{ exit_code: number; stack: unknown[] }> {
        const endpoint = await this.manager.getEndpoint();
        const baseV2 = toV2Base(endpoint);
        const url = `${baseV2}/runGetMethod`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    accept: 'application/json',
                },
                body: JSON.stringify({
                    address,
                    method,
                    stack,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            const json = await response.json();
            const data = this.unwrapResponse(json);

            if (data.exit_code === undefined) {
                throw new Error('Missing exit_code in response');
            }

            this.manager.reportSuccess();
            return {
                exit_code: data.exit_code,
                stack: data.stack || [],
            };
        } catch (error: any) {
            clearTimeout(timeoutId);
            this.manager.reportError(error);
            throw error;
        }
    }

    /**
     * Get masterchain info
     */
    async getMasterchainInfo(
        timeoutMs: number = 10000
    ): Promise<{
        seqno: number;
        stateRootHash: string;
    }> {
        const data = await this.jsonRpc<{
            last: { seqno: number };
            state_root_hash: string;
        }>('getMasterchainInfo', {}, timeoutMs);

        return {
            seqno: data.last?.seqno || 0,
            stateRootHash: data.state_root_hash || '',
        };
    }

    // ========================================================================
    // Provider Management
    // ========================================================================

    /**
     * Get provider manager
     */
    getManager(): ProviderManager {
        return this.manager;
    }

    /**
     * Get active provider info
     */
    getActiveProviderInfo(): { id: string; name: string; isCustom: boolean } | null {
        return this.manager.getActiveProviderInfo();
    }

    /**
     * Get provider health results
     */
    getProviderHealthResults(): ProviderHealthResult[] {
        return this.manager.getProviderHealthResults();
    }

    /**
     * Test all providers
     */
    async testAllProviders(): Promise<ProviderHealthResult[]> {
        return this.manager.testAllProviders();
    }

    // ========================================================================
    // Private Helpers
    // ========================================================================

    /**
     * Unwrap TON API response
     */
    private unwrapResponse(json: unknown): any {
        if (json && typeof json === 'object' && 'ok' in json) {
            const resp = json as { ok: boolean; result?: unknown; error?: string };
            if (!resp.ok) {
                throw new Error(resp.error || 'API returned ok=false');
            }
            return resp.result ?? json;
        }

        // JSON-RPC response
        if (json && typeof json === 'object' && 'result' in json) {
            return (json as { result: unknown }).result;
        }

        return json;
    }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a Browser adapter
 */
export function createBrowserAdapter(manager: ProviderManager, logger?: Logger): BrowserAdapter {
    return new BrowserAdapter(manager, logger);
}

/**
 * Create a Browser adapter with auto-initialized manager
 */
export async function createBrowserAdapterForNetwork(
    network: Network,
    configPath?: string,
    logger?: Logger
): Promise<BrowserAdapter> {
    const manager = new ProviderManager({
        configPath,
        adapter: 'browser',
        logger,
    });

    await manager.init(network);
    return new BrowserAdapter(manager, logger);
}
