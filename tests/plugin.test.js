import { promises as fsPromises } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import heroicons from '../index.js'

const outlineSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true" data-slot="icon">
  <path stroke-linecap="round" stroke-linejoin="round" fill="none" d="M0 0h24v24H0z"/>
</svg>
`

const solidSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 20">
  <path fill="none" d="M0 0h20v20H0z"/>
</svg>
`

const tempRoots = []

const createTempRoot = async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'heroicons-plugin-'))
  tempRoots.push(root)
  return root
}

const addIcon = async (root, relativeDir, iconName, content) => {
  const iconDir = path.join(root, relativeDir)
  await fsPromises.mkdir(iconDir, { recursive: true })
  await fsPromises.writeFile(path.join(iconDir, `${iconName}.svg`), content, 'utf8')
}

const createContext = () => {
  const warnings = []
  const emitted = []

  return {
    warnings,
    emitted,
    hooks: {
      warn(message) {
        warnings.push(String(message))
      },
      emitFile(asset) {
        emitted.push(asset)
      },
    },
  }
}

afterEach(async () => {
  vi.restoreAllMocks()

  await Promise.all(
    tempRoots.splice(0).map(root => fsPromises.rm(root, { recursive: true, force: true })),
  )
})

describe('heroicons plugin', () => {
  it('emits deduplicated symbols in deterministic order', async () => {
    const root = await createTempRoot()

    await addIcon(root, 'icons', 'a', solidSvg)
    await addIcon(root, 'icons', 'b', solidSvg)

    const plugin = heroicons({
      inject: false,
      iconSets: {
        foo: 'icons',
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()

    plugin.transform.handler('<use href="#foo/b"></use><use href="#foo/a"></use><use href="#foo/a"></use>', '/src/app.html', { ssr: false })

    const context = createContext()
    await plugin.generateBundle.call(context.hooks)

    expect(context.emitted).toHaveLength(1)

    const source = context.emitted[0].source
    const matches = source.match(/<symbol id="foo\/a"/g) ?? []

    expect(matches).toHaveLength(1)
    expect(source.indexOf('id="foo/a"')).toBeLessThan(source.indexOf('id="foo/b"'))
    expect(source).not.toContain('fill="none"')
  })

  it('extracts ids from quoted and unquoted href syntax', async () => {
    const root = await createTempRoot()

    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({
      inject: false,
      iconSets: {
        foo: 'icons',
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()

    plugin.transform.handler('<use href="#foo/check"></use><use xlink:href=#foo/check></use>', '/src/app.html', { ssr: false })

    const context = createContext()
    await plugin.generateBundle.call(context.hooks)

    expect(context.emitted).toHaveLength(1)
    expect(context.emitted[0].source).toContain('id="foo/check"')
  })

  it('clears references after hot update', async () => {
    const root = await createTempRoot()

    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({
      inject: false,
      iconSets: {
        foo: 'icons',
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()

    plugin.transform.handler('<use href="#foo/check"></use>', '/src/page.html', { ssr: false })

    const context = createContext()
    await plugin.generateBundle.call(context.hooks)
    expect(context.emitted).toHaveLength(1)

    context.emitted.length = 0
    plugin.handleHotUpdate({ file: '/src/page.html' })

    await plugin.generateBundle.call(context.hooks)
    expect(context.emitted).toHaveLength(0)
  })

  it('warns only once per missing icon id', async () => {
    const root = await createTempRoot()
    await fsPromises.mkdir(path.join(root, 'icons'), { recursive: true })

    const plugin = heroicons({
      inject: false,
      iconSets: {
        foo: 'icons',
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()

    plugin.transform.handler('<use href="#foo/missing"></use>', '/src/a.html', { ssr: false })

    const context = createContext()
    await plugin.generateBundle.call(context.hooks)

    plugin.transform.handler('<use href="#foo/missing"></use>', '/src/b.html', { ssr: false })
    await plugin.generateBundle.call(context.hooks)

    expect(context.warnings).toHaveLength(1)
  })

  it('injects sprite with HtmlTagDescriptor and reuses cache for bundle', async () => {
    const root = await createTempRoot()

    await addIcon(root, 'icons', 'academic-cap', outlineSvg)

    const plugin = heroicons({
      inject: true,
      iconSets: {
        'heroicons-outline': 'icons',
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    const readSpy = vi.spyOn(fsPromises, 'readFile')

    const transformed = await plugin.transformIndexHtml.handler.call(
      context.hooks,
      '<html><body><use href="#heroicons-outline/academic-cap"></use></body></html>',
      { filename: '/src/index.html', path: '/index.html' },
    )

    expect(typeof transformed).toBe('object')
    expect(transformed.tags).toHaveLength(1)
    expect(transformed.tags[0].tag).toBe('svg')
    expect(transformed.tags[0].children).toContain('id="heroicons-outline/academic-cap"')
    expect(transformed.tags[0].children).not.toContain('stroke-linecap')

    await plugin.generateBundle.call(context.hooks)
    expect(readSpy).toHaveBeenCalledTimes(1)
    expect(context.emitted).toHaveLength(1)
  })

  it('builds transform code filter from configured icon prefixes', () => {
    const plugin = heroicons({
      iconSets: {
        foo: 'icons',
        bar: 'icons2',
      },
    })

    const include = plugin.transform.filter.code.include

    expect(Array.isArray(include)).toBe(true)
    expect(include).toContain('#foo/')
    expect(include).toContain('#bar/')
  })
})
