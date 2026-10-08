/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#effaf6', 100: '#d7f3e8', 200: '#b1e6d3', 300: '#7fd2b8', 400: '#4bb899',
          500: '#289d80', 600: '#1b7f68', 700: '#186654', 800: '#165144', 900: '#144339',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
