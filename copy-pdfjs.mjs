import { cpSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(__dirname, '../extension/resources/pdfjs')
const dest = path.resolve(__dirname, 'out/pdfjs')

mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
console.log('[copy-pdfjs] Copied pdfjs to out/pdfjs/')
