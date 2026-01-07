/**
 * Standardized aggregation size limits to prevent data limit errors
 * All tools should use these constants instead of magic numbers
 */
export const AGGREGATION_LIMITS = {
  // Terms aggregations
  SMALL: 10,      // For single-entity summaries (e.g., top 5 accounts in a group)
  MEDIUM: 50,     // For distributions, subscriptions, ratings
  LARGE: 100,     // For platform breakdowns, top N queries
  MAX: 200,       // Absolute maximum (rarely used)
  
  // Date histogram buckets
  MAX_BUCKETS: 12, // For time series (daily/weekly/monthly trends)
  
  // Safeguards
  MAX_TOP_N: 50,    // Cap on topN parameters
  MAX_LIMIT: 50,    // Cap on limit parameters
  MAX_SIZE: 50,     // Cap on search size parameter
} as const;

/**
 * Calculate safe terms aggregation size
 * @param requested - Requested number of items
 * @param multiplier - Multiplier for fetching extra items (default: 2)
 * @param max - Maximum allowed (default: LARGE)
 * @returns Safe aggregation size
 */
export function calculateTermsSize(
  requested: number,
  multiplier: number = 2,
  max: number = AGGREGATION_LIMITS.LARGE
): number {
  return Math.min(requested * multiplier, max);
}


