export class RateLimiter {
  private timestamps: number[] = [];

  constructor(private maxRequestsPerMinute: number) {}

  private async wait(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }

  /**
   * Schedule a function respecting the rate limit.
   */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    // Remove timestamps older than 60s
    this.timestamps = this.timestamps.filter((ts) => now - ts < 60_000);

    if (this.timestamps.length >= this.maxRequestsPerMinute) {
      const earliest = this.timestamps[0];
      const waitTime = 60_000 - (now - earliest) + 50; // slight buffer
      await this.wait(waitTime);
    }

    const result = await fn();
    this.timestamps.push(Date.now());
    return result;
  }
} 