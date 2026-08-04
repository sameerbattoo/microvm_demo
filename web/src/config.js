/**
 * Runtime configuration derived from Vite environment variables.
 * Set VITE_PROXY_PORT and VITE_BACKEND_PORT when launching the dev server.
 * Falls back to defaults if not set.
 */
export const PROXY_PORT = import.meta.env.VITE_PROXY_PORT || '8081'
export const BACKEND_PORT = import.meta.env.VITE_BACKEND_PORT || '8080'

export const PROXY_URL = `http://localhost:${PROXY_PORT}`
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`

// Network timeout for API calls (ms)
// AWS API calls (Glue, DynamoDB, S3) can be slow under throttling
export const API_TIMEOUT_MS = 30000

// Longer timeout for AI generation calls (model inference takes 10-30s)
export const AI_TIMEOUT_MS = 60000
