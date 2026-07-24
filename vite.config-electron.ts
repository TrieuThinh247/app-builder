import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Extension project root (sibling directory)
const extensionRoot = path.resolve(__dirname, '../extension')

export default defineConfig({
  plugins: [react()],
  base: './',
  root: path.resolve(extensionRoot, 'src/webview'),
  build: {
    outDir: path.resolve(__dirname, 'out/webview'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: '[name].js',
        assetFileNames: (assetInfo) => {
          // Rename CSS to main.css to match what the provider expects
          if (assetInfo.names?.[0]?.endsWith('.css') || assetInfo.name?.endsWith('.css')) {
            return 'main.css'
          }
          return '[name][extname]'
        },
      },
    },
  },
  resolve: {
    // Force vite to resolve node_modules từ app-builder thay vì từ extension root
    // Cần thiết khi vite root nằm ngoài folder chứa node_modules
    modules: [path.resolve(__dirname, 'node_modules'), 'node_modules'],
    alias: {
      '@': path.resolve(extensionRoot, 'src/webview'),
    },
  },
})
