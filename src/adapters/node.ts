/**
 * Unified Provider System - Node.js Adapter
 *
 * Provides TonClient integration for Node.js environments.
 * Handles client caching and endpoint changes.
 */

import { TonClient } from '@ton/ton';
import { Address, Cell } from '@ton/core';
import type { Network, ResolvedProvider, Logger } from '../types';
import { ProviderManager } from '../core/manager';
import { normalizeV2Endpoint, toV2Base } from '../utils/endpoint';
import { withTimeout, fetchWithTimeout } from '../utils/timeout';

// ============================================================================
// Console Logger (default)
// ============================================================================

const consoleLogger: Logger = {
    debug: (msg, data) => console.debug(`[NodeAdapter] ${msg}`, data || ''),
    info: (msg, data) => console.log(`[NodeAdapter] ${msg}`, data || ''),
    warn: (msg, data) => console.warn(`[NodeAdapter] ${msg}`, data || ''),
    error: (msg, data) => console.error(`[NodeAdapter] ${msg}`, data || ''),
};

// ============================================================================
// TonClient Cache
// ============================================================================

interface CachedClient {
    client: TonClient;
    endpoint: string;
    network: Network;
    createdAt: number;
}

let cachedClient: CachedClient | null = null;

// ============================================================================
// Node Adapter
// ============================================================================

/**
 * Node.js Adapter for Provider System
 *
 * Provides TonClient and direct REST API access for Node.js environments.
 */
export class NodeAdapter {
    private manager: ProviderManager;
    private logger: Logger;

    constructor(manager: ProviderManager, logger?: Logger) {
        this.manager = manager;
        this.logger = logger || consoleLogger;
    }

    /**
     * Get TonClient instance
     *
     * Creates a new client if endpoint changed, otherwise returns cached.
     */
    async getClient(): Promise<TonClient> {
        const endpoint = await this.manager.getEndpoint();
        const network = this.manager.getNetwork();

        if (!network) {
            throw new Error('ProviderManager not initialized');
        }

        // Check if cached client is still valid
        if (
            cachedClient &&
            cachedClient.endpoint === endpoint &&
            cachedClient.network === network
        ) {
            return cachedClient.client;
        }

        // Create new client
        const provider = this.manager.getActiveProvider();
        const apiKey = provider?.apiKey;

        const client = new TonClient({
            endpoint,
            apiKey,
        });

        cachedClient = {
            client,
            endpoint,
            network,
            createdAt: Date.now(),
        };

        this.logger.debug(`Created TonClient for ${network}`, { endpoint });

        return client;
    }

    /**
     * Reset client cache (forces new client creation)
     */
    resetClient(): void {
        cachedClient = null;
        this.logger.debug('Client cache cleared');
    }

    /**
     * Get cached client info (for debugging)
     */
    getClientInfo(): { endpoint: string; network: Network; age: number } | null {
        if (!cachedClient) return null;
        return {
            endpoint: cachedClient.endpoint,
            network: cachedClient.network,
            age: Date.now() - cachedClient.createdAt,
        };
    }

    // ========================================================================
    // Direct REST API Methods
    // ========================================================================

    /**
     * Get address state via REST API
     */
    async getAddressState(
        address: Address | string,
        timeoutMs: number = 10000
    ): Promise<'uninit' | 'active' | 'frozen'> {
        const endpoint = await this.manager.getEndpoint();
        const baseV2 = toV2Base(endpoint);
        const addrStr = typeof address === 'string' ? address : address.toString();
        const url = `${baseV2}/getAddressState?address=${encodeURIComponent(addrStr)}`;

        try {
            const response = await fetchWithTimeout(
                url,
                { headers: { accept: 'application/json' } },
                timeoutMs
            );

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
            this.manager.reportError(error);
            throw error;
        }
    }

    /**
     * Get address balance via REST API
     */
    async getAddressBalance(
        address: Address | string,
        timeoutMs: number = 10000
    ): Promise<bigint> {
        const endpoint = await this.manager.getEndpoint();
        const baseV2 = toV2Base(endpoint);
        const addrStr = typeof address === 'string' ? address : address.toString();
        const url = `${baseV2}/getAddressBalance?address=${encodeURIComponent(addrStr)}`;

        try {
            const response = await fetchWithTimeout(
                url,
                { headers: { accept: 'application/json' } },
                timeoutMs
            );

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
            this.manager.reportError(error);
            throw error;
        }
    }

    /**
     * Run a get method via REST API
     */
    async runGetMethod(
        address: Address | string,
        method: string,
        stack: unknown[] = [],
        timeoutMs: number = 15000
    ): Promise<{ exit_code: number; stack: unknown[] }> {
        const endpoint = await this.manager.getEndpoint();
        const baseV2 = toV2Base(endpoint);
        const addrStr = typeof address === 'string' ? address : address.toString();
        const url = `${baseV2}/runGetMethod`;

        try {
            const response = await fetchWithTimeout(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        accept: 'application/json',
                    },
                    body: JSON.stringify({
                        address: addrStr,
                        method,
                        stack,
                    }),
                },
                timeoutMs
            );

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
            this.manager.reportError(error);
            throw error;
        }
    }

    /**
     * Send BOC via REST API
     */
    async sendBoc(
        boc: Buffer | string,
        timeoutMs: number = 30000
    ): Promise<void> {
        const endpoint = await this.manager.getEndpoint();
        const baseV2 = toV2Base(endpoint);
        const url = `${baseV2}/sendBoc`;
        const bocBase64 = typeof boc === 'string' ? boc : boc.toString('base64');

        try {
            const response = await fetchWithTimeout(
                url,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ boc: bocBase64 }),
                },
                timeoutMs
            );

            const json = await response.json();
            this.unwrapResponse(json);
            this.manager.reportSuccess();
        } catch (error: any) {
            this.manager.reportError(error);
            throw error;
        }
    }

    /**
     * Check if contract is deployed
     */
    async isContractDeployed(
        address: Address | string,
        timeoutMs: number = 10000
    ): Promise<boolean> {
        try {
            const state = await this.getAddressState(address, timeoutMs);
            return state === 'active';
        } catch {
            return false;
        }
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
 * Create a Node adapter
 */
export function createNodeAdapter(manager: ProviderManager, logger?: Logger): NodeAdapter {
    return new NodeAdapter(manager, logger);
}

/**
 * Get TonClient from ProviderManager (convenience function)
 */
export async function getTonClient(manager: ProviderManager): Promise<TonClient> {
    const adapter = new NodeAdapter(manager);
    return adapter.getClient();
}

/**
 * Get TonClient for network (one-shot convenience)
 */
export async function getTonClientForNetwork(
    network: Network,
    configPath?: string
): Promise<TonClient> {
    const manager = ProviderManager.getInstance({ configPath });

    if (!manager.isInitialized() || manager.getNetwork() !== network) {
        await manager.init(network);
    }

    return getTonClient(manager);
}

/**
 * Reset all cached state
 */
export function resetNodeAdapter(): void {
    cachedClient = null;
    ProviderManager.resetInstance();
}
