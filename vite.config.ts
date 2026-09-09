import { defineConfig } from 'vite'

export default defineConfig({
  base: '/linux-lab/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
