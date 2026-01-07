/**
 * Utilities for parsing and working with Elasticsearch date math expressions
 */

/**
 * Resolve a date string (ISO or relative math) to a Javascript Date object
 * @param dateStr - Date string (e.g., "now", "now-30d", "2023-01-01")
 * @returns Date object
 * @throws Error if date format is invalid
 */
export function resolveDate(dateStr: string): Date {
  // Handle "now"
  if (dateStr === 'now') {
    return new Date();
  }

  // Handle relative math "now-..."
  if (dateStr.startsWith('now-')) {
    const match = dateStr.match(/now-(\d+)([dwMy]|\+)?/);
    if (!match) {
      throw new Error(`Invalid relative date format: ${dateStr}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];
    const now = new Date();

    switch (unit) {
      case 'd':
      case 'D':
        now.setDate(now.getDate() - value);
        break;
      case 'w':
      case 'W':
        now.setDate(now.getDate() - (value * 7));
        break;
      case 'M':
        now.setMonth(now.getMonth() - value);
        break;
      case 'y':
      case 'Y':
        now.setFullYear(now.getFullYear() - value);
        break;
      default:
        // Default to days if unit is missing or unknown (safe fallback for simple cases)
        now.setDate(now.getDate() - value);
    }
    return now;
  }

  // Handle ISO strings
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Invalid date format: ${dateStr}`);
  }
  return parsed;
}

/**
 * Legacy wrapper for backward compatibility, though discouraged.
 * returns number of days relative to now.
 */
export function parseDateMath(dateStr: string): number {
  if (dateStr === 'now') return 0;

  try {
    const date = resolveDate(dateStr);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  } catch (e) {
    // Fallback for very simple day parsing if resolveDate fails or strictly for "now-Nd" extraction
    const match = dateStr.match(/now-(\d+)([dwMy])/);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      if (unit === 'd' || unit === 'D') return value;
      if (unit === 'w' || unit === 'W') return value * 7;
      if (unit === 'M') return value * 30;
      if (unit === 'y' || unit === 'Y') return value * 365;
      return 0;
    }
    return 30;
  }
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


