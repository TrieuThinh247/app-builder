import { build, context } from 'esbuild'

const isWatch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['./electron/main.ts'],
  bundle: true,
  outfile: './out/electron/main.js',
  external: ['electron'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
}

async function main() {
  if (isWatch) {
    const ctx = await context(buildOptions)
    await ctx.watch()
    console.log('[esbuild] Watching electron main...')
  } else {
    await build(buildOptions)
    console.log('[esbuild] Electron main built successfully.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
