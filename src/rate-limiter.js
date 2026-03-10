/**
 * In-memory sliding-window rate limiter.
 * Tracks events per key (socket ID or IP) within a time window.
 */
class RateLimiter {
  /**
   * @param {number} points   Max events allowed
   * @param {number} duration Window in seconds
   */
  constructor(points = 60, duration = 60) {
    this.points = points;
    this.duration = duration * 1000; // convert to ms
    this.clients = new Map(); // key -> { count, resetAt }
  }

  /**
   * Consume one point for the given key.
   * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
   */
  consume(key) {
    const now = Date.now();
    let entry = this.clients.get(key);

    // Reset or create entry if window expired
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.duration };
      this.clients.set(key, entry);
    }

    entry.count++;

    if (entry.count > this.points) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: entry.resetAt - now,
      };
    }

    return {
      allowed: true,
      remaining: this.points - entry.count,
      retryAfterMs: 0,
    };
  }

  /**
   * Remove a key (on disconnect)
   */
  remove(key) {
    this.clients.delete(key);
  }

  /**
   * Periodic cleanup of expired entries
   */
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.clients) {
      if (now >= entry.resetAt) {
        this.clients.delete(key);
      }
    }
  }
}

export default RateLimiter;
