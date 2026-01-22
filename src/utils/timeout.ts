/**
 * Unified Provider System - Timeout Utilities
 *
 * Promise timeout helpers for async operations.
 */

import { TimeoutError } from '../types';

// ============================================================================
// Default Timeouts
// ============================================================================

/** Default timeout for TON provider requests */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30000;

/** Default timeout for contract calls */
export const DEFAULT_CONTRACT_TIMEOUT_MS = 45000;

/** Default timeout for health checks */
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 10000;

// ============================================================================
// Timeout Functions
// ============================================================================

/**
 * Execute a promise with a timeout.
 *
 * @param promise - The promise to execute
 * @param timeoutMs - Timeout in milliseconds
 * @param operationName - Name of the operation (for error messages)
 * @returns The result of the promise
 * @throws TimeoutError if the operation times out
 */
export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operationName: string
): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new TimeoutError(operationName, timeoutMs));
        }, timeoutMs);

        // Clear timeout if promise resolves/rejects before timeout
        // This prevents memory leaks in Node.js
        promise.finally(() => clearTimeout(timeoutId));
    });

    return Promise.race([promise, timeoutPromise]);
}

/**
 * Execute a function with a timeout.
 *
 * @param fn - The async function to execute
 * @param timeoutMs - Timeout in milliseconds
 * @param operationName - Name of the operation (for error messages)
 * @returns The result of the function
 * @throws TimeoutError if the operation times out
 */
export async function withTimeoutFn<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    operationName: string
): Promise<T> {
    return withTimeout(fn(), timeoutMs, operationName);
}

/**
 * Create an AbortController with automatic timeout.
 *
 * @param timeoutMs - Timeout in milliseconds
 * @returns AbortController that will abort after timeout
 */
export function createTimeoutController(timeoutMs: number): {
    controller: AbortController;
    clear: () => void;
} {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    return {
        controller,
        clear: () => clearTimeout(timeoutId),
    };
}

/**
 * Execute a fetch request with timeout.
 *
 * @param url - The URL to fetch
 * @param options - Fetch options (excluding signal)
 * @param timeoutMs - Timeout in milliseconds
 * @returns Fetch response
 * @throws TimeoutError if the request times out
 */
export async function fetchWithTimeout(
    url: string,
    options: Omit<RequestInit, 'signal'>,
    timeoutMs: number
): Promise<Response> {
    const { controller, clear } = createTimeoutController(timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });
        return response;
    } catch (error: any) {
        if (error.name === 'AbortError') {
            throw new TimeoutError(url, timeoutMs, `Fetch to ${url} timed out after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clear();
    }
}

// ============================================================================
// Retry Utilities
// ============================================================================

/**
 * Retry options for async operations.
 */
export interface RetryOptions {
    /** Maximum number of retry attempts */
    maxRetries: number;
    /** Base delay between retries in ms */
    baseDelayMs: number;
    /** Maximum delay between retries in ms */
    maxDelayMs: number;
    /** Backoff multiplier for exponential backoff */
    backoffMultiplier: number;
    /** Function to determine if error is retryable */
    isRetryable?: (error: Error) => boolean;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
};

/**
 * Execute a function with automatic retries on failure.
 *
 * @param fn - The async function to execute
 * @param options - Retry options
 * @returns The result of the function
 * @throws The last error if all retries fail
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options?: Partial<RetryOptions>
): Promise<T> {
    const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;

            // Check if error is retryable
            if (opts.isRetryable && !opts.isRetryable(error)) {
                throw error;
            }

            // Don't wait after last attempt
            if (attempt < opts.maxRetries) {
                const delay = Math.min(
                    opts.baseDelayMs * Math.pow(opts.backoffMultiplier, attempt),
                    opts.maxDelayMs
                );
                await sleep(delay);
            }
        }
    }

    throw lastError || new Error('Retry failed');
}

/**
 * Execute a function with both timeout and retry.
 *
 * @param fn - The async function to execute
 * @param timeoutMs - Timeout per attempt in milliseconds
 * @param operationName - Name of the operation
 * @param retryOptions - Retry options
 * @returns The result of the function
 */
export async function withTimeoutAndRetry<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    operationName: string,
    retryOptions?: Partial<RetryOptions>
): Promise<T> {
    return withRetry(
        () => withTimeout(fn(), timeoutMs, operationName),
        {
            ...retryOptions,
            isRetryable: (error) => {
                // Timeout errors are retryable
                if (error instanceof TimeoutError) {
                    return true;
                }
                // Custom retryable check
                if (retryOptions?.isRetryable) {
                    return retryOptions.isRetryable(error);
                }
                // Default: retry on network errors
                const message = error.message?.toLowerCase() || '';
                return (
                    message.includes('network') ||
                    message.includes('fetch') ||
                    message.includes('econnrefused') ||
                    message.includes('etimedout')
                );
            },
        }
    );
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sleep for a specified duration.
 *
 * @param ms - Duration in milliseconds
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is a timeout error.
 */
export function isTimeoutError(error: unknown): error is TimeoutError {
    return error instanceof TimeoutError;
}

/**
 * Check if an error appears to be a rate limit error.
 */
export function isRateLimitError(error: unknown): boolean {
    if (!error) return false;
    const message = (error as any).message?.toLowerCase() || '';
    const status = (error as any).status || (error as any).response?.status;
    return status === 429 || message.includes('rate limit') || message.includes('429');
}
