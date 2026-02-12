import { promises as fs } from 'node:fs'
import process from 'node:process'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import heroicons from '../index.js'

const DEFAULT_ICON_SETS = {
  'heroicons-outline': 'node_modules/heroicons/24/outline',
  'heroicons-solid': 'node_modules/heroicons/24/solid',
  'heroicons-mini': 'node_modules/heroicons/20/solid',
  'heroicons-micro': 'node_modules/heroicons/16/solid',
}

const transformNoIconBenchmark = async () => {
  const plugin = heroicons({ inject: false })
  plugin.configResolved({ root: process.cwd() })
  plugin.buildStart()

  const iterations = 200
  const code = 'const value = 1;\n'.repeat(20_000)
  const start = performance.now()

  for (let index = 0; index < iterations; index += 1) {
    plugin.transform.handler(code, `/src/no-icon-${index}.js`, { ssr: false })
  }

  return performance.now() - start
}

const collectIconIds = async (total = 200) => {
  const collected = []

  for (const [prefix, relativeDir] of Object.entries(DEFAULT_ICON_SETS)) {
    if (collected.length >= total) {
      break
    }

    const absoluteDir = path.resolve(process.cwd(), relativeDir)
    const fileNames = (await fs.readdir(absoluteDir)).filter(fileName => fileName.endsWith('.svg')).sort()

    for (const fileName of fileNames) {
      if (collected.length >= total) {
        break
      }

      const iconName = fileName.slice(0, -4)
      collected.push(`${prefix}/${iconName}`)
    }
  }

  return collected
}

const buildSpriteBenchmark = async () => {
  const iconIds = await collectIconIds(200)
  const plugin = heroicons({ inject: false })
  plugin.configResolved({ root: process.cwd() })
  plugin.buildStart()

  const references = iconIds
    .map(iconId => `<use href="#${iconId}"></use>`)
    .join('')

  plugin.transform.handler(references, '/src/icons.html', { ssr: false })

  const context = {
    warn() {},
    emitFile() {},
  }

  const start = performance.now()
  await plugin.generateBundle.call(context)
  return performance.now() - start
}

const run = async () => {
  const noIconMs = await transformNoIconBenchmark()
  const spriteMs = await buildSpriteBenchmark()

  console.log(`no-icon transform x200: ${noIconMs.toFixed(2)}ms`)
  console.log(`cold sprite build (200 icons): ${spriteMs.toFixed(2)}ms`)
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
