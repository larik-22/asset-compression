import { logger } from './logger.js';

/**
 * Execute an async function, retrying with exponential back-off if the provided
 * predicate determines the error is a rate-limit condition.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    baseDelayMs?: number;
    isRateLimitError?: (error: unknown) => boolean;
  },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 5;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const isRateLimitError =
    options?.isRateLimitError ??
    ((error: any) => {
      const status = error?.status ?? error?.response?.status;
      return status === 429;
    });

  let attempt = 0;
  let delay = baseDelayMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      if (!isRateLimitError(error) || attempt >= maxRetries) {
        throw error;
      }

      const retryAfterHeader = Number(error?.response?.headers?.['retry-after']);
      const waitTime = !Number.isNaN(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : delay;

      attempt += 1;
      logger.warn(`Rate limited (429). Retry attempt ${attempt}/${maxRetries} in ${Math.round(waitTime / 1000)}s.`);
      await new Promise((res) => setTimeout(res, waitTime));
      delay *= 2; // exponential back-off
    }
  }
} 