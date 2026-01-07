/**
 * Utilities for parsing and working with Elasticsearch date math expressions
 */

/**
 * Parse an Elasticsearch date math expression and return the number of days
 * @param dateStr - Date string (e.g., "now", "now-30d", "now-1y")
 * @returns Number of days (0 for "now", positive for "now-Nd")
 */
export function parseDateMath(dateStr: string): number {
  if (dateStr === 'now') {
    return 0; // "now" = 0 days ago
  }
  if (dateStr.startsWith('now-')) {
    // Match patterns like "now-180d", "now-12w", "now-12M", "now-1y"
    // Note: In Elasticsearch date math: 'M' (uppercase) = months, 'm' (lowercase) = minutes
    // We only match uppercase 'M' for months, lowercase 'm' would be minutes (negligible for our use case)
    const match = dateStr.match(/now-(\d+)([dwMy])/);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      if (unit === 'd' || unit === 'D') return value;
      if (unit === 'w' || unit === 'W') return value * 7;
      if (unit === 'M') return value * 30; // Uppercase M = months (approximate as 30 days)
      if (unit === 'y' || unit === 'Y') return value * 365;
      // Lowercase 'm' = minutes, which is negligible (< 1 day), so return 0
      if (unit === 'm') return 0;
    }
  }
  // For ISO dates or other formats, assume it's within the last 30 days
  // This is a rough approximation - actual parsing would require date library
  return 30;
}

/**
 * Cap a time period to a maximum number of days
 * @param startDate - Start date string
 * @param endDate - End date string
 * @param maxDays - Maximum number of days allowed
 * @param logger - Logger instance for warnings
 * @returns Adjusted dates and whether adjustment was made
 */
export function capTimePeriod(
  startDate: string,
  endDate: string,
  maxDays: number,
  logger: { warn: (message: string, meta: any) => void }
): { startDate: string; endDate: string; wasAdjusted: boolean } {
  const startDays = parseDateMath(startDate);
  const endDays = parseDateMath(endDate);
  const periodDays = Math.abs(startDays - endDays);
  
  if (periodDays > maxDays) {
    const adjustedStart = startDate.startsWith('now-') ? `now-${maxDays}d` : startDate;
    logger.warn('Time period capped to prevent data limit errors', {
      originalStartDate: startDate,
      originalEndDate: endDate,
      originalPeriodDays: periodDays,
      adjustedStartDate: adjustedStart,
      adjustedEndDate: endDate,
      adjustedPeriodDays: maxDays,
    });
    return { startDate: adjustedStart, endDate, wasAdjusted: true };
  }
  return { startDate, endDate, wasAdjusted: false };
}


