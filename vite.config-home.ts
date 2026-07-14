import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  root: path.resolve(__dirname, 'src/home-webview'),
  build: {
    outDir: path.resolve(__dirname, 'out/home-webview'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: '[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.[0]?.endsWith('.css') || assetInfo.name?.endsWith('.css')) {
            return 'main.css'
          }
          return '[name][extname]'
        },
      },
    },
  },
})
