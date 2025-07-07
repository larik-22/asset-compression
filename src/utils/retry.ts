import { logger } from './logger.js';
import { Webflow } from 'webflow-api';

/**
 * Execute an async function, retrying with exponential back-off if the Webflow API
 * responds with a rate-limit error (HTTP 429).
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  baseDelayMs = 1000,
): Promise<T> {
  let attempt = 0;
  let delay = baseDelayMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      const is429 =
        (error instanceof Webflow.TooManyRequestsError) ||
        (error?.status === 429);

      if (!is429 || attempt >= maxRetries) {
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