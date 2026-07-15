/**
 * MicroVM Connection Service
 *
 * Handles authenticated requests to Lambda MicroVMs.
 *
 * Two modes:
 * 1. Local dev mode — no auth needed, direct HTTP to localhost
 * 2. MicroVM mode — requests go through a token proxy that injects
 *    the X-aws-proxy-auth header
 *
 * In production (MicroVM mode), the flow is:
 *   Browser → Token Proxy (localhost:8081) → MicroVM endpoint
 *
 * The token proxy:
 *   - Holds AWS credentials (never exposed to browser)
 *   - Calls create-microvm-auth-token to get JWE tokens
 *   - Caches tokens (they last 30 min)
 *   - Forwards requests with the auth header injected
 */

export class MicroVMClient {
  constructor(endpoint, { proxyUrl = null } = {}) {
    this.endpoint = endpoint
    this.proxyUrl = proxyUrl
    this.isLocal = endpoint.includes('localhost') || endpoint.includes('127.0.0.1')
  }

  async request(path, options = {}) {
    const url = this.isLocal
      ? `${this.endpoint}${path}`
      : `${this.proxyUrl || this.endpoint}${path}`

    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    }

    // If using the proxy, add the target endpoint header
    if (!this.isLocal && this.proxyUrl) {
      headers['X-MicroVM-Endpoint'] = this.endpoint
    }

    const response = await fetch(url, {
      ...options,
      headers,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`HTTP ${response.status}: ${text}`)
    }

    return response.json()
  }

  async health() {
    return this.request('/health')
  }

  async execute(code) {
    return this.request('/execute', {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
  }

  async install(packageName) {
    return this.request('/install', {
      method: 'POST',
      body: JSON.stringify({ package: packageName }),
    })
  }

  async variables() {
    return this.request('/variables')
  }

  async reset() {
    return this.request('/reset', { method: 'POST' })
  }
}
