import { useState, useEffect, useCallback } from 'react'

/**
 * useTheme — persisted app theme ('dark' | 'light' | 'ember') with a 3-way toggle.
 * Applies data-theme to <html> and saves to localStorage.
 */
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('microvm-theme') || 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('microvm-theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      if (prev === 'dark') return 'light'
      if (prev === 'light') return 'ember'
      return 'dark'
    })
  }, [])

  return { theme, toggleTheme }
}
