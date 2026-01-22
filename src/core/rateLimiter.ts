/**
 * Unified Provider System - Rate Limiter
 *
 * Token bucket rate limiter with per-provider tracking.
 * Implements request queuing, serialization, and exponential backoff.
 */

import type { RateLimitConfig, RateLimitState, Logger } from '../types';
import { RateLimitError } from '../types';
import { sleep } from '../utils/timeout';

// ============================================================================
// Console Logger (default)
// ============================================================================

const consoleLogger: Logger = {
    debug: (msg, data) => console.debug(`[RateLimiter] ${msg}`, data || ''),
    info: (msg, data) => console.log(`[RateLimiter] ${msg}`, data || ''),
    warn: (msg, data) => console.warn(`[RateLimiter] ${msg}`, data || ''),
    error: (msg, data) => console.error(`[RateLimiter] ${msg}`, data || ''),
};

// ============================================================================
// Default Rate Limit Configurations
// ============================================================================

/**
 * Default rate limit config (conservative for public endpoints)
 */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
    rps: 1,
    burstSize: 3,
    minDelayMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 30000,
};

/**
 * Chainstack free plan limits (25 RPS)
 */
export const CHAINSTACK_RATE_LIMIT: RateLimitConfig = {
    rps: 25,
    burstSize: 30,
    minDelayMs: 40,
    backoffMultiplier: 2,
    maxBackoffMs: 10000,
};

/**
 * QuickNode free plan limits (10 RPS)
 */
export const QUICKNODE_RATE_LIMIT: RateLimitConfig = {
    rps: 10,
    burstSize: 15,
    minDelayMs: 100,
    backoffMultiplier: 2,
    maxBackoffMs: 10000,
};

/**
 * Orbs TON Access (decentralized, no hard limit)
 */
export const ORBS_RATE_LIMIT: RateLimitConfig = {
    rps: 10,
    burstSize: 20,
    minDelayMs: 100,
    backoffMultiplier: 2,
    maxBackoffMs: 10000,
};

/**
 * Get rate limit config by provider type
 */
export function getRateLimitForType(type: string): RateLimitConfig {
    switch (type.toLowerCase()) {
        case 'chainstack':
            return CHAINSTACK_RATE_LIMIT;
        case 'quicknode':
            return QUICKNODE_RATE_LIMIT;
        case 'orbs':
            return ORBS_RATE_LIMIT;
        default:
            return DEFAULT_RATE_LIMIT;
    }
}

// ============================================================================
// Token Bucket Rate Limiter
// ============================================================================

/**
 * Token Bucket Rate Limiter
 *
 * Implements a token bucket algorithm with:
 * - Configurable RPS and burst size
 * - Request queuing (FIFO)
 * - Serialized request processing
 * - Exponential backoff on 429 errors
 */
export class TokenBucketRateLimiter {
    private config: RateLimitConfig;
    private tokens: number;
    private lastRefill: number;
    private currentBackoff: number = 0;
    private consecutiveErrors: number = 0;
    private requestQueue: Array<() => void> = [];
    private processing: boolean = false;
    private logger: Logger;

    constructor(config?: Partial<RateLimitConfig>, logger?: Logger) {
        this.config = { ...DEFAULT_RATE_LIMIT, ...config };
        this.tokens = this.config.burstSize;
        this.lastRefill = Date.now();
        this.logger = logger || consoleLogger;
    }

    /**
     * Get current state
     */
    getState(): RateLimitState {
        this.refill();
        return {
            tokens: this.tokens,
            lastRefill: this.lastRefill,
            currentBackoff: this.currentBackoff,
            consecutiveErrors: this.consecutiveErrors,
            processing: this.processing,
            queueLength: this.requestQueue.length,
        };
    }

    /**
     * Acquire a token (wait if necessary)
     *
     * @param timeoutMs - Maximum time to wait for a token (default: 60s)
     * @returns true if token acquired, false if timeout
     */
    async acquire(timeoutMs: number = 60000): Promise<boolean> {
        const startTime = Date.now();

        // If already processing, wait in queue
        if (this.processing) {
            const acquired = await new Promise<boolean>((resolve) => {
                const checkTimeout = () => {
                    if (Date.now() - startTime > timeoutMs) {
                        // Remove from queue and reject
                        const idx = this.requestQueue.indexOf(resolveCallback);
                        if (idx >= 0) {
                            this.requestQueue.splice(idx, 1);
                        }
                        resolve(false);
                    }
                };

                const resolveCallback = () => resolve(true);
                this.requestQueue.push(resolveCallback);

                // Set timeout to check periodically
                const timeoutInterval = setInterval(checkTimeout, 1000);
                const cleanup = () => clearInterval(timeoutInterval);

                // Cleanup when resolved
                Promise.resolve().then(() => {
                    if (this.requestQueue.includes(resolveCallback)) {
                        // Still in queue, wait for resolution
                    } else {
                        cleanup();
                    }
                });
            });

            if (!acquired) {
                return false;
            }
        }

        // Mark as processing
        this.processing = true;

        try {
            // Refill tokens
            this.refill();

            // Apply backoff if active
            if (this.currentBackoff > 0) {
                this.logger.debug(`Applying backoff: ${this.currentBackoff}ms`);
                await sleep(this.currentBackoff);
                // After backoff, reset lastRefill to ensure proper delay calculation
                // This prevents getting tokens too quickly after backoff
                this.lastRefill = Date.now();
                // Clear backoff after applying it (it will be set again if we get another 429)
                this.currentBackoff = 0;
            }

            // Wait for token if none available
            while (this.tokens <= 0) {
                if (Date.now() - startTime > timeoutMs) {
                    return false;
                }

                // Wait for minimum delay
                await sleep(Math.min(100, this.config.minDelayMs));
                this.refill();
            }

            // Consume token
            this.tokens--;

            // Apply minimum delay between requests (always enforce for rate limiting)
            // For very low RPS providers, we must always enforce the delay to prevent 429 errors
            // After backoff, we still need to ensure minDelayMs has passed since lastRefill
            const timeSinceLastRefill = Date.now() - this.lastRefill;
            if (timeSinceLastRefill < this.config.minDelayMs) {
                await sleep(this.config.minDelayMs - timeSinceLastRefill);
            }
            // Note: If timeSinceLastRefill >= minDelayMs, we've already waited long enough
            // due to the token refill mechanism, so no additional delay is needed
            // However, we still update lastRefill to track when this request was made

            // Update lastRefill AFTER the delay to ensure accurate timing for next request
            this.lastRefill = Date.now();
            return true;
        } finally {
            // Release lock and process next in queue
            this.processing = false;
            if (this.requestQueue.length > 0) {
                const next = this.requestQueue.shift()!;
                next();
            }
        }
    }

    /**
     * Release a token (call on request completion)
     */
    release(): void {
        // Token is automatically restored by refill()
        // This method can be used for custom logic if needed
    }

    /**
     * Report a successful request (resets backoff)
     */
    reportSuccess(): void {
        this.currentBackoff = 0;
        this.consecutiveErrors = 0;
    }

    /**
     * Report a rate limit error (applies backoff)
     */
    reportRateLimitError(): void {
        this.consecutiveErrors++;

        // Apply exponential backoff
        if (this.currentBackoff === 0) {
            this.currentBackoff = this.config.minDelayMs * this.config.backoffMultiplier;
        } else {
            this.currentBackoff = Math.min(
                this.currentBackoff * this.config.backoffMultiplier,
                this.config.maxBackoffMs
            );
        }

        // Reset tokens to 0 on rate limit error to prevent immediate retry
        // Reset lastRefill to now so that refill calculation is correct after backoff
        // This ensures we wait for backoff + proper token refill before next request
        this.tokens = 0;
        this.lastRefill = Date.now();

        this.logger.warn(`Rate limit hit, backoff: ${this.currentBackoff}ms, errors: ${this.consecutiveErrors}`);
    }

    /**
     * Report a general error
     */
    reportError(): void {
        this.consecutiveErrors++;

        // Less aggressive backoff for non-rate-limit errors
        if (this.consecutiveErrors >= 3) {
            this.currentBackoff = Math.min(
                this.config.minDelayMs * this.consecutiveErrors,
                this.config.maxBackoffMs / 2
            );
        }
    }

    /**
     * Reset rate limiter state
     */
    reset(): void {
        this.tokens = this.config.burstSize;
        this.lastRefill = Date.now();
        this.currentBackoff = 0;
        this.consecutiveErrors = 0;
        // Don't clear queue - let pending requests complete
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<RateLimitConfig>): void {
        this.config = { ...this.config, ...config };
        // Adjust burst size if needed
        if (this.tokens > this.config.burstSize) {
            this.tokens = this.config.burstSize;
        }
    }

    /**
     * Refill tokens based on time elapsed
     */
    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const tokensToAdd = Math.floor((elapsed / 1000) * this.config.rps);

        if (tokensToAdd > 0) {
            this.tokens = Math.min(this.config.burstSize, this.tokens + tokensToAdd);
            this.lastRefill = now;
        }
    }
}

// ============================================================================
// Provider Rate Limiter Manager
// ============================================================================

/**
 * Provider Rate Limiter Manager
 *
 * Manages rate limiters for multiple providers.
 */
export class RateLimiterManager {
    private limiters: Map<string, TokenBucketRateLimiter> = new Map();
    private configs: Map<string, RateLimitConfig> = new Map();
    private logger: Logger;

    constructor(logger?: Logger) {
        this.logger = logger || consoleLogger;
    }

    /**
     * Get or create rate limiter for a provider
     */
    getLimiter(providerId: string, config?: Partial<RateLimitConfig>): TokenBucketRateLimiter {
        let limiter = this.limiters.get(providerId);

        if (!limiter) {
            const savedConfig = this.configs.get(providerId);
            limiter = new TokenBucketRateLimiter(
                { ...savedConfig, ...config },
                this.logger
            );
            this.limiters.set(providerId, limiter);
        }

        return limiter;
    }

    /**
     * Set rate limit config for a provider
     */
    setConfig(providerId: string, config: RateLimitConfig): void {
        this.configs.set(providerId, config);

        // Update existing limiter if present
        const limiter = this.limiters.get(providerId);
        if (limiter) {
            limiter.updateConfig(config);
        }
    }

    /**
     * Get rate limit state for a provider
     */
    getState(providerId: string): RateLimitState | null {
        const limiter = this.limiters.get(providerId);
        return limiter ? limiter.getState() : null;
    }

    /**
     * Acquire token for a provider
     */
    async acquire(providerId: string, timeoutMs?: number): Promise<boolean> {
        const limiter = this.getLimiter(providerId);
        return limiter.acquire(timeoutMs);
    }

    /**
     * Report success for a provider
     */
    reportSuccess(providerId: string): void {
        const limiter = this.limiters.get(providerId);
        if (limiter) {
            limiter.reportSuccess();
        }
    }

    /**
     * Report rate limit error for a provider
     */
    reportRateLimitError(providerId: string): void {
        const limiter = this.getLimiter(providerId);
        limiter.reportRateLimitError();
    }

    /**
     * Report general error for a provider
     */
    reportError(providerId: string): void {
        const limiter = this.getLimiter(providerId);
        limiter.reportError();
    }

    /**
     * Reset a provider's rate limiter
     */
    reset(providerId: string): void {
        const limiter = this.limiters.get(providerId);
        if (limiter) {
            limiter.reset();
        }
    }

    /**
     * Reset all rate limiters
     */
    resetAll(): void {
        for (const limiter of this.limiters.values()) {
            limiter.reset();
        }
    }

    /**
     * Remove a provider's rate limiter
     */
    remove(providerId: string): void {
        this.limiters.delete(providerId);
        this.configs.delete(providerId);
    }

    /**
     * Clear all limiters
     */
    clear(): void {
        this.limiters.clear();
        this.configs.clear();
    }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a rate limiter with RPS-based config
 */
export function createRateLimiter(rps: number, logger?: Logger): TokenBucketRateLimiter {
    return new TokenBucketRateLimiter(
        {
            rps,
            burstSize: Math.max(3, Math.ceil(rps * 1.5)),
            minDelayMs: Math.ceil(1000 / rps),
            backoffMultiplier: 2,
            maxBackoffMs: 30000,
        },
        logger
    );
}

/**
 * Create a rate limiter manager
 */
export function createRateLimiterManager(logger?: Logger): RateLimiterManager {
    return new RateLimiterManager(logger);
}
