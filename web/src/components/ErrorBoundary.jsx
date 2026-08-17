import { Component } from 'react'

export default class ErrorBoundary extends Component {
  state = { hasError: false, error: null }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Uncaught error:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '3rem', textAlign: 'center', color: '#ccc', fontFamily: 'system-ui', background: '#0b0e14', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <h2 style={{ color: '#ff5c5c', marginBottom: '0.5rem' }}>Something went wrong</h2>
          <p style={{ color: '#9aa4b5', maxWidth: 500, lineHeight: 1.6 }}>{this.state.error?.message || 'An unexpected error occurred in the application.'}</p>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: '1.5rem', padding: '10px 20px', background: '#5b8cff', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px', fontWeight: 600 }}
          >
            Reload Application
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
