/**
 * Utilities for parsing and working with Elasticsearch date math expressions
 */

/**
 * Resolve a date string (ISO or relative math) to a Javascript Date object
 * Supports:
 * - "now"
 * - Relative math: "now-1d", "now+2w", "now-1M"
 * - Rounding: "now/d", "now/M", "now/y"
 * - Combined: "now-1d/d"
 * 
 * @param dateStr - Date string
 * @returns Date object
 * @throws Error if date format is invalid
 */
export function resolveDate(dateStr: string): Date {
  if (dateStr === 'now') {
    return new Date();
  }

  // Handle standard Elasticsearch date math: now[+|-][num][unit][/rounding]
  if (dateStr.startsWith('now')) {
    const now = new Date();
    let workingStr = dateStr.substring(3); // Remove 'now'

    // 1. Parse Offset (e.g. -1d, +2w)
    // Match optional +/- followed by digits and unit
    const offsetMatch = workingStr.match(/^([+-])(\d+)([dMwYy])/);
    if (offsetMatch) {
      const operator = offsetMatch[1];
      const value = parseInt(offsetMatch[2], 10);
      const unit = offsetMatch[3];

      const multiplier = operator === '-' ? -1 : 1;
      const amount = value * multiplier;

      switch (unit) {
        case 'd':
        case 'D':
          now.setDate(now.getDate() + amount);
          break;
        case 'w':
        case 'W':
          now.setDate(now.getDate() + (amount * 7));
          break;
        case 'M':
          now.setMonth(now.getMonth() + amount);
          break;
        case 'y':
        case 'Y':
          now.setFullYear(now.getFullYear() + amount);
          break;
      }

      // Advance string past the offset
      workingStr = workingStr.substring(offsetMatch[0].length);
    }

    // 2. Parse Rounding (e.g. /d, /M)
    // Check if remaining string starts with /
    if (workingStr.startsWith('/')) {
      const roundingUnit = workingStr.substring(1, 2); // get char after /

      switch (roundingUnit) {
        case 'd':
        case 'D':
          now.setHours(0, 0, 0, 0);
          break;
        case 'w':
        case 'W':
          // Set to previous Monday (or Sunday depending on locale, standard ES is Monday iirc but let's stick to simple day rounding for now or 0 day of week)
          // For simplicity/safety let's assume Sunday=0. ES uses Monday as start of week usually.
          // Let's implement Monday rounding:
          const day = now.getDay();
          const diff = now.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
          now.setDate(diff);
          now.setHours(0, 0, 0, 0);
          break;
        case 'M':
          now.setDate(1);
          now.setHours(0, 0, 0, 0);
          break;
        case 'y':
        case 'Y':
          now.setMonth(0, 1);
          now.setHours(0, 0, 0, 0);
          break;
      }
      workingStr = workingStr.substring(2);
    }

    if (workingStr.length > 0) {
      // If there's still junk left, it might be invalid or unsupported syntax
      // For now, if we processed something, ignoring trailing junk might be risky, but throwing is safer
      throw new Error(`Invalid or unsupported date math format: ${dateStr}`);
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
