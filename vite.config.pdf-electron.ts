import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { copyFileSync, mkdirSync } from 'fs'

// Extension project root (sibling directory)
const extensionRoot = path.resolve(__dirname, '../extension')

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'copy-pdfjs-worker',
      closeBundle() {
        // Copy PDF.js worker file from extension's node_modules to output directory
        const workerSrc = path.resolve(
          extensionRoot,
          'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
        )
        const workerDest = path.resolve(
          __dirname,
          'out/pdf-webview/pdf.worker.min.mjs'
        )
        mkdirSync(path.dirname(workerDest), { recursive: true })
        copyFileSync(workerSrc, workerDest)
        console.log('[vite-pdf] Copied pdf.worker.min.mjs to out/pdf-webview/')
      },
    },
  ],
  base: './',
  root: path.resolve(extensionRoot, 'src/pdf-webview'),
  build: {
    outDir: path.resolve(__dirname, 'out/pdf-webview'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'iife',
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
  resolve: {
    alias: {
      '@pdf': path.resolve(extensionRoot, 'src/pdf-webview'),
    },
  },
})
