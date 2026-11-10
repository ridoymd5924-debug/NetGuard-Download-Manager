/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ng: {
          bg: 'rgb(var(--ng-bg) / <alpha-value>)',
          surface: 'rgb(var(--ng-surface) / <alpha-value>)',
          surfaceHover: 'rgb(var(--ng-surfaceHover) / <alpha-value>)',
          border: 'rgb(var(--ng-border) / <alpha-value>)',
          accent: 'rgb(var(--ng-accent) / <alpha-value>)',
          accentHover: 'rgb(var(--ng-accentHover) / <alpha-value>)',
          success: 'rgb(var(--ng-success) / <alpha-value>)',
          warning: 'rgb(var(--ng-warning) / <alpha-value>)',
          danger: 'rgb(var(--ng-danger) / <alpha-value>)',
          text: 'rgb(var(--ng-text) / <alpha-value>)',
          textSecondary: 'rgb(var(--ng-textSecondary) / <alpha-value>)',
          textMuted: 'rgb(var(--ng-textMuted) / <alpha-value>)',
          accentMuted: 'rgb(var(--ng-accent) / 0.125)',
        }
      },
      fontFamily: {
        sans: ['Segoe UI Variable', 'Segoe UI', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['Cascadia Mono', 'Consolas', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out',
      },
      keyframes: {
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideDown: {
          '0%': { transform: 'translateY(-10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      }
    },
  },
  plugins: [],
}
