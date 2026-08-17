/**
 * Centralized error/warning logger.
 * Replaces silent catch {} blocks with at minimum a console warning.
 * When moving to production, swap console calls for CloudWatch/Sentry.
 */

export function logError(source, error, context = {}) {
  console.error(`[${source}]`, error?.message || error, context)
}

export function logWarn(source, message, context = {}) {
  console.warn(`[${source}]`, message, context)
}
