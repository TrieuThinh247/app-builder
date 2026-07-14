import { build, context } from 'esbuild'

const isWatch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions[]} */
const buildConfigs = [
  {
    entryPoints: ['./electron/preload.ts'],
    bundle: true,
    outfile: './out/electron/preload.js',
    external: ['electron'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    minify: false,
  },
  {
    entryPoints: ['./electron/sidebar-preload.ts'],
    bundle: true,
    outfile: './out/electron/sidebar-preload.js',
    external: ['electron'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    minify: false,
  },
  {
    entryPoints: ['./electron/home-preload.ts'],
    bundle: true,
    outfile: './out/electron/home-preload.js',
    external: ['electron'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    minify: false,
  },
]

async function main() {
  if (isWatch) {
    const ctxs = await Promise.all(buildConfigs.map((cfg) => context(cfg)))
    await Promise.all(ctxs.map((ctx) => ctx.watch()))
    console.log('[esbuild] Watching electron preloads...')
  } else {
    await Promise.all(buildConfigs.map((cfg) => build(cfg)))
    console.log('[esbuild] Electron preloads built successfully.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
