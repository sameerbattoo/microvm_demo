/** Centralized UI/behavior constants — single source of truth. */

// VM instance polling interval (ms) — how often the frontend checks for VM state changes
export const DEFAULT_POLL_INTERVAL_MS = 10000

// Intel generation polling intervals (ms)
export const INTEL_GENERATING_POLL_MS = 4000
export const INTEL_IDLE_POLL_MS = 10000
export const INTEL_MAX_POLL_ATTEMPTS = 200

// Maximum rows to display in cell output tables before truncation
export const MAX_DISPLAY_ROWS = 50
