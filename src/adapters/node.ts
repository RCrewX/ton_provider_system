/**
 * Unified Provider System - Node.js Adapter
 *
 * Provides TonClient integration for Node.js environments.
 * Handles client caching and endpoint changes.
 */

import { TonClient } from '@ton/ton';
import { Address, Cell } from '@ton/core';
import type { Transaction } from '@ton/core';
import type { Network, ResolvedProvider, Logger } from '../types';
import { ProviderManager } from '../core/manager';
import { normalizeV2Endpoint, toV2Base, redactUrl } from '../utils/endpoint';
import { withTimeout, fetchWithTimeout, sleep } from '../utils/timeout';

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
     * 
     * NOTE: Direct TonClient calls bypass rate limiting. For rate-limited operations,
     * use adapter methods (getAddressState, runGetMethod, etc.) or wrap your calls
     * with rate limit token acquisition.
     * 
     * Example with rate limiting:
     * ```typescript
     * const endpoint = await adapter.manager.getEndpointWithRateLimit();
     * // Make your TonClient call
     * adapter.manager.reportSuccess(); // or reportError() on failure
     * ```
     */
    async getClient(): Promise<TonClient> {
        // Use getEndpoint() (not getEndpointWithRateLimit) to avoid blocking on client creation
        // Rate limiting should be applied per-operation, not per-client-creation
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

        this.logger.debug(`Created TonClient for ${network}`, { endpoint: redactUrl(endpoint) });

        return client;
    }

    /**
     * Get TonClient with rate limiting applied
     * 
     * Acquires a rate limit token before returning the client.
     * Use this when you need to ensure rate limiting is respected.
     * 
     * Note: This only acquires ONE token. For multiple operations,
     * you should acquire tokens before each operation or use adapter methods.
     */
    async getClientWithRateLimit(timeoutMs?: number): Promise<TonClient> {
        // Acquire rate limit token before creating/returning client
        await this.manager.getEndpointWithRateLimit(timeoutMs);
        return this.getClient();
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
    // Failover-aware high-level reads
    // ========================================================================

    /**
     * Get account transactions with capability-aware provider failover.
     *
     * Unlike `getClient().getTransactions(...)`, this builds a candidate set of the
     * network's *transaction-capable* providers (score-ordered, best first) and
     * loops over THAT set. Providers known not to serve the v2 `getTransactions`
     * shape — flagged `servesGetTransactions: false` in config (Chainstack/Orbs
     * testnet, which pass the `getMasterchainInfo` health probe but 403 on
     * transaction reads) — are excluded UP FRONT. They are never called and never
     * `reportError`-ed here, so their global health stays intact and the fast
     * get-method path keeps using them (a wasted 403 would otherwise evict them).
     *
     * Semantics (per capable candidate, in score order):
     *  1. Acquire a rate-limit token for THAT provider, bind a short-lived
     *     `TonClient` to its endpoint, and call `getTransactions`.
     *  2. On success → `reportSuccess(provider.id)` and return.
     *  3. On a GENUINE error → `reportError(error, provider.id)` (marks THAT
     *     provider success:false + clears the selection cache) and try the next
     *     capable candidate.
     *  4. When every capable candidate has been tried, re-throw the last error so
     *     the caller's retry/dead-letter logic still triggers.
     *  5. If there is NO capable provider at all, throw a clear error.
     *
     * Returns the same `Transaction[]` `TonClient.getTransactions` returns, so a
     * consumer can swap `client.getTransactions(addr, opts)` for
     * `adapter.getTransactions(addr, opts)` with no shape change.
     */
    async getTransactions(
        address: Address | string,
        opts: {
            limit?: number;
            lt?: string;
            hash?: string;
            to_lt?: string;
            inclusive?: boolean;
            archival?: boolean;
        } = {},
        timeoutMs: number = 15000
    ): Promise<Transaction[]> {
        const network = this.manager.getNetwork();
        if (!network) {
            throw new Error('ProviderManager not initialized');
        }

        const addr = typeof address === 'string' ? Address.parse(address) : address;
        const reqOpts = { limit: opts.limit ?? 20, ...opts };

        // Capability-filtered, score-ordered candidates. Incapable providers
        // (servesGetTransactions:false) are simply not in this list — so we never
        // call them and never poison their health. The list is finite, so the loop
        // is naturally bounded.
        const candidates = this.manager.getTransactionCapableProviders();
        if (candidates.length === 0) {
            throw new Error(
                `getTransactions: no transaction-capable provider for ${network}`
            );
        }

        const rateLimiter = this.manager.getRateLimiter();
        let lastError: unknown;

        for (const provider of candidates) {
            // Respect the provider's rate limit (best-effort: never let token
            // acquisition block the whole failover indefinitely).
            if (rateLimiter) {
                await rateLimiter.acquire(provider.id, timeoutMs);
            }

            // Bind a short-lived client to THIS specific candidate's endpoint so
            // failover never reuses a client pinned to a different provider. Capable
            // candidates are static v2 (Orbs dynamic discovery is capability-excluded).
            const endpoint = normalizeV2Endpoint(provider.endpointV2, provider);
            const client = new TonClient({ endpoint, apiKey: provider.apiKey });

            try {
                const result = await withTimeout(
                    client.getTransactions(addr, reqOpts),
                    timeoutMs,
                    `getTransactions(${provider.id})`
                );
                this.manager.reportSuccess(provider.id);
                return result;
            } catch (error: any) {
                lastError = error;
                this.logger.warn(
                    `getTransactions failed on ${provider.id}, failing over`,
                    { error: error?.message || String(error) }
                );
                // Attribute the failure to THIS candidate (marks it success:false +
                // clears the selection cache) — a genuine failure among the capable
                // providers, not a capability exclusion.
                this.manager.reportError(error, provider.id);
            }
        }

        // Every capable candidate was tried and failed — surface the last error.
        throw (
            lastError ||
            new Error(`getTransactions: all transaction-capable providers failed for ${network}`)
        );
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
     * Broadcast an already-signed external message BOC, with provider failover.
     *
     * Unlike a single-endpoint `client.sendFile`/raw POST, this walks the network's
     * score-ordered providers (best first; see ProviderManager.getBroadcastCapableProviders)
     * and fails over to the next provider when one returns a TRANSIENT failure — a
     * 429 (rate limit), a 5xx (gateway/server error, e.g. the testnet chainstack
     * free plan 500ing on sendBoc), a timeout, or a network error. This closes the
     * broadcast half of the failover story: the getTransactions capability flag only
     * diverted reads, so a demoted-but-still-reachable provider could still 500 a
     * broadcast — now the broadcast itself moves on to a healthy provider.
     *
     * Safety: re-broadcasting is idempotent at the TON level — the external message
     * has a deterministic hash, so forwarding the SAME signed BOC to another provider
     * after a transient failure is safe (the network dedups; a duplicate is a no-op).
     * A 4xx that means "this BOC is invalid" (400/413/422) is therefore NOT failed
     * over: it is the payload, not the provider — surfaced immediately, without
     * poisoning the provider's health or spraying a bad BOC across the fleet.
     */
    async sendBoc(
        boc: Buffer | string,
        timeoutMs: number = 30000
    ): Promise<void> {
        const network = this.manager.getNetwork();
        if (!network) {
            throw new Error('ProviderManager not initialized');
        }
        const bocBase64 = typeof boc === 'string' ? boc : boc.toString('base64');

        const candidates = this.manager.getBroadcastCapableProviders();
        if (candidates.length === 0) {
            // No selectable provider — fall back to the legacy single-endpoint path
            // (best provider / public fallback) so we never regress to "no broadcast".
            const endpoint = await this.manager.getEndpoint();
            try {
                await this.sendBocToEndpoint(endpoint, bocBase64, timeoutMs);
                this.manager.reportSuccess();
            } catch (error: any) {
                if (!this.isInvalidPayloadError(error)) {
                    this.manager.reportError(error);
                }
                throw error;
            }
            return;
        }

        const rateLimiter = this.manager.getRateLimiter();
        let lastError: unknown;

        for (const provider of candidates) {
            if (rateLimiter) {
                await rateLimiter.acquire(provider.id, timeoutMs);
            }
            // Static v2 endpoint for this candidate. (Dynamic providers fall back to
            // their static gateway URL here; they sit last in score order so they are
            // only reached as a broadcast backstop.)
            const endpoint = normalizeV2Endpoint(provider.endpointV2, provider);

            try {
                await this.sendBocToEndpoint(endpoint, bocBase64, timeoutMs);
                this.manager.reportSuccess(provider.id);
                return;
            } catch (error: any) {
                // Invalid-payload 4xx → the BOC is bad, not the provider. Surface it
                // immediately: don't fail over and don't mark the provider unhealthy.
                if (this.isInvalidPayloadError(error)) {
                    throw error;
                }
                lastError = error;
                this.manager.reportError(error, provider.id);
                this.logger.warn(
                    `sendBoc failed on ${provider.id}, failing over`,
                    { error: error?.message || String(error) }
                );
            }
        }

        // Every provider was tried and failed on a transient error — surface the last.
        throw (
            lastError ||
            new Error(`sendBoc: all providers failed for ${network}`)
        );
    }

    /**
     * POST a base64 BOC to one provider's REST `/sendBoc`. Throws on a non-2xx
     * response with the HTTP `status` attached (so the caller can classify
     * transient vs invalid-payload), and on an `ok:false` JSON body.
     */
    private async sendBocToEndpoint(
        endpoint: string,
        bocBase64: string,
        timeoutMs: number
    ): Promise<void> {
        const baseV2 = toV2Base(endpoint);
        const url = `${baseV2}/sendBoc`;
        const response = await fetchWithTimeout(
            url,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ boc: bocBase64 }),
            },
            timeoutMs
        );
        if (!response.ok) {
            const err: any = new Error(
                `HTTP ${response.status} ${response.statusText} on sendBoc`
            );
            err.status = response.status;
            throw err;
        }
        const json = await response.json();
        this.unwrapResponse(json);
    }

    /**
     * True only for a 4xx that means the BOC payload itself is invalid (400 Bad
     * Request, 413 Payload Too Large, 422 Unprocessable) — these must NOT fail over
     * (the next provider would reject the same BOC identically). Auth/availability
     * 4xx (401/403/404), 429, 5xx, timeouts and network errors are all transient
     * for an idempotent broadcast and DO fail over.
     */
    private isInvalidPayloadError(error: unknown): boolean {
        const status = (error as any)?.status;
        return typeof status === 'number' && (status === 400 || status === 413 || status === 422);
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
 * 
 * WARNING: Direct TonClient API calls bypass rate limiting!
 * For rate-limited operations, use one of these approaches:
 * 
 * 1. Use adapter methods (recommended):
 *    ```typescript
 *    const adapter = new NodeAdapter(manager);
 *    const state = await adapter.getAddressState(address);
 *    ```
 * 
 * 2. Acquire rate limit tokens before operations:
 *    ```typescript
 *    await manager.getEndpointWithRateLimit(); // Acquire token
 *    const result = await client.someMethod();
 *    manager.reportSuccess(); // or reportError() on failure
 *    ```
 * 
 * 3. Use getTonClientWithRateLimit() for operations that need rate limiting
 */
export async function getTonClient(manager: ProviderManager): Promise<TonClient> {
    const adapter = new NodeAdapter(manager);
    return adapter.getClient();
}

/**
 * Get TonClient with rate limiting wrapper
 * 
 * Returns a TonClient along with helper methods to ensure rate limiting.
 * Use this when you need to make multiple TonClient calls with rate limiting.
 * 
 * Example:
 * ```typescript
 * const { client, withRateLimit } = await getTonClientWithRateLimit(manager);
 * 
 * // Wrap your operations
 * const balance = await withRateLimit(() => client.getBalance(address));
 * const state = await withRateLimit(() => client.getContractState(address));
 * ```
 */
export async function getTonClientWithRateLimit(
    manager: ProviderManager
): Promise<{
    client: TonClient;
    withRateLimit: <T>(fn: () => Promise<T>, maxRetries?: number) => Promise<T>;
}> {
    const adapter = new NodeAdapter(manager);
    const client = await adapter.getClient();
    
    const withRateLimit = async <T>(
        fn: () => Promise<T>,
        maxRetries: number = 3
    ): Promise<T> => {
        let lastError: Error | unknown;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                // Acquire rate limit token before operation
                await manager.getEndpointWithRateLimit(60000);
                
                // Execute the operation
                const result = await fn();
                
                // Report success (resets backoff)
                manager.reportSuccess();
                return result;
            } catch (error: any) {
                lastError = error;
                
                // Check if it's a rate limit error (429)
                const errorMsg = error?.message || String(error) || '';
                const is429 = 
                    errorMsg.includes('429') ||
                    errorMsg.includes('rate limit') ||
                    error?.status === 429 ||
                    error?.response?.status === 429;
                
                if (is429 && attempt < maxRetries) {
                    // Report rate limit error (applies backoff)
                    manager.reportError(error);
                    
                    // Get current backoff from rate limiter state
                    const managerState = manager.getState();
                    const provider = manager.getActiveProvider();
                    let backoff = 1000; // Default backoff
                    
                    if (provider && managerState.providers) {
                        const providerState = managerState.providers.get(provider.id);
                        if (providerState?.rateLimit?.currentBackoff) {
                            backoff = providerState.rateLimit.currentBackoff;
                        }
                    }
                    
                    // Wait for backoff + additional delay based on attempt
                    // For low RPS providers (like Tatum with 3 RPS = 334ms), we need longer waits
                    const additionalDelay = Math.min(attempt * 500, 2000);
                    const waitTime = backoff + additionalDelay;
                    
                    // Use console.warn since we can't access private logger
                    console.warn(
                        `[ProviderSystem] Rate limit error (429), retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries + 1})`
                    );
                    await sleep(waitTime);
                    continue;
                }
                
                // Not a 429 error, or max retries reached
                manager.reportError(error);
                throw error;
            }
        }
        
        // Should never reach here, but TypeScript needs it
        throw lastError || new Error('Rate limit retries exhausted');
    };
    
    return { client, withRateLimit };
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
