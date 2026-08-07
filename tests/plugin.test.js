import { Buffer } from 'node:buffer'
import { promises as fsPromises } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

const largeSolidSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path d="M1 1h22v22H1z"/>
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

const addFile = async (root, relativePath, content) => {
  const filePath = path.join(root, relativePath)
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true })
  await fsPromises.writeFile(filePath, content, 'utf8')
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
    plugin.hotUpdate({ file: '/src/page.html' })

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

  it('collects icons from content files during generateBundle', async () => {
    const root = await createTempRoot()

    await addIcon(root, 'icons', 'check', solidSvg)
    await addFile(root, 'templates/page.latte', '<use href="#foo/check"></use>')

    const plugin = heroicons({
      content: ['templates/**/*.latte'],
      inject: false,
      iconSets: {
        foo: 'icons',
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    await plugin.generateBundle.call(context.hooks)

    expect(context.emitted).toHaveLength(1)
    expect(context.emitted[0].source).toContain('id="foo/check"')
  })

  it('deduplicates symbols across transform and content scanning', async () => {
    const root = await createTempRoot()

    await addIcon(root, 'icons', 'check', solidSvg)
    await addFile(root, 'templates/page.latte', '<use href="#foo/check"></use>')

    const plugin = heroicons({
      content: ['templates/**/*.latte'],
      inject: false,
      iconSets: {
        foo: 'icons',
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()
    plugin.transform.handler('<use href="#foo/check"></use>', '/src/app.html', { ssr: false })

    const context = createContext()
    await plugin.generateBundle.call(context.hooks)

    expect(context.emitted).toHaveLength(1)
    expect(context.emitted[0].source.match(/<symbol id="foo\/check"/g)).toHaveLength(1)
  })

  it('collects icons from symlinked content files during generateBundle', async () => {
    const root = await createTempRoot()

    await addIcon(root, 'icons', 'check', solidSvg)
    await addFile(root, 'shared/page.latte', '<use href="#foo/check"></use>')
    await fsPromises.mkdir(path.join(root, 'templates'), { recursive: true })
    await fsPromises.symlink('../shared/page.latte', path.join(root, 'templates', 'page.latte'))

    const plugin = heroicons({
      content: ['templates/**/*.latte'],
      inject: false,
      iconSets: {
        foo: 'icons',
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    await plugin.generateBundle.call(context.hooks)

    expect(context.emitted).toHaveLength(1)
    expect(context.emitted[0].source).toContain('id="foo/check"')
  })

  it('resolves icon sets from multiple directories in order', async () => {
    const root = await createTempRoot()

    await addIcon(root, 'icons-primary', 'star', largeSolidSvg)
    await addIcon(root, 'icons-fallback', 'check', solidSvg)
    await addIcon(root, 'icons-fallback', 'star', solidSvg)

    const plugin = heroicons({
      inject: false,
      iconSets: {
        foo: ['icons-primary', 'icons-fallback'],
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()

    plugin.transform.handler('<use href="#foo/check"></use><use href="#foo/star"></use>', '/src/app.html', { ssr: false })

    const context = createContext()
    await plugin.generateBundle.call(context.hooks)

    expect(context.emitted).toHaveLength(1)
    expect(context.emitted[0].source).toContain('id="foo/check" viewBox="0 0 20 20"')
    expect(context.emitted[0].source).toContain('id="foo/star" viewBox="0 0 24 24"')
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

  it('skips sprite injection for json-like HTML outputs by default', async () => {
    const root = await createTempRoot()

    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({
      inject: true,
      iconSets: {
        foo: 'icons',
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    const html = '{"content":"<use href=#foo/check></use>"}'
    const transformed = await plugin.transformIndexHtml.handler.call(
      context.hooks,
      html,
      { filename: '/src/pages/basic.json.latte.html', path: '/basic.json.html' },
    )

    expect(transformed).toBe(html)

    await plugin.generateBundle.call(context.hooks)
    expect(context.emitted).toHaveLength(1)
    expect(context.emitted[0].source).toContain('id="foo/check"')
  })

  it('still injects sprite for direct .json.html pages', async () => {
    const root = await createTempRoot()

    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({
      inject: true,
      iconSets: {
        foo: 'icons',
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    const transformed = await plugin.transformIndexHtml.handler.call(
      context.hooks,
      '<html><body><use href="#foo/check"></use></body></html>',
      { filename: '/src/pages/basic.json.html', path: '/basic.json.html' },
    )

    expect(typeof transformed).toBe('object')
    expect(transformed.tags).toHaveLength(1)
    expect(transformed.tags[0].children).toContain('id="foo/check"')
  })

  it('allows overriding injectExclude for json-like HTML outputs', async () => {
    const root = await createTempRoot()

    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({
      inject: true,
      injectExclude: [],
      iconSets: {
        foo: 'icons',
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    const transformed = await plugin.transformIndexHtml.handler.call(
      context.hooks,
      '{"content":"<use href=#foo/check></use>"}',
      { filename: '/src/pages/basic.json.latte.html', path: '/basic.json.html' },
    )

    expect(typeof transformed).toBe('object')
    expect(transformed.tags).toHaveLength(1)
    expect(transformed.tags[0].children).toContain('id="foo/check"')
  })

  it('waits for dev pre-transforms before injecting sprite', async () => {
    const root = await createTempRoot()

    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({
      inject: true,
      iconSets: {
        foo: 'icons',
      },
    })

    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    const transformed = await plugin.transformIndexHtml.handler.call(
      context.hooks,
      '<html><body></body></html>',
      {
        filename: '/src/index.html',
        path: '/index.html',
        server: {
          async waitForRequestsIdle() {
            plugin.transform.handler(
              '<svg><use href="#foo/check"></use></svg>',
              '/src/app.js',
              { ssr: false },
            )
          },
        },
      },
    )

    expect(typeof transformed).toBe('object')
    expect(transformed.tags).toHaveLength(1)
    expect(transformed.tags[0].children).toContain('id="foo/check"')
  })

  it('skips collecting refs during server transforms via environment consumer', async () => {
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

    plugin.transform.handler.call(
      { environment: { config: { consumer: 'server' } } },
      '<use href="#foo/check"></use>',
      '/src/page.html',
    )

    const context = createContext()
    await plugin.generateBundle.call(context.hooks)

    expect(context.emitted).toHaveLength(0)
  })

  it('injects compiled Astro documents during server transforms', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    const transformed = await plugin.transform.handler.call(
      { ...context.hooks, environment: { config: { consumer: 'server' } } },
      'import { render } from "astro/compiler-runtime"; export default render`<html><body><use href="#foo/check"></use></body></html>`',
      path.join(root, 'src/pages/index.astro'),
    )

    expect(transformed.code).not.toContain('data-vite-plugin-heroicons')
    expect(transformed.code).toContain('id="foo/check"')
    expect(transformed.code.indexOf('id="foo/check"')).toBeLessThan(transformed.code.indexOf('</body>'))
    expect(transformed.map).toBeTruthy()
  })

  it('leaves Astro injection to the integration middleware', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.hooks['astro:config:setup']({
      config: { vite: {} },
      updateConfig() {},
      addMiddleware() {},
    })
    plugin.configResolved({ root, command: 'build' })
    plugin.buildStart()

    const context = createContext()
    const transformed = await plugin.transform.handler.call(
      { ...context.hooks, environment: { config: { consumer: 'server' } } },
      'import { render } from "astro/compiler-runtime"; export default render`<html><body><use href="#foo/check"></use></body></html>`',
      path.join(root, 'src/pages/index.astro'),
    )
    const htmlTransform = await plugin.transformIndexHtml.handler.call(
      context.hooks,
      '<html><body><use href="#foo/check"></use></body></html>',
      { filename: '/index.html', path: '/index.html' },
    )

    expect(transformed).toBeNull()
    expect(htmlTransform).toBe('<html><body><use href="#foo/check"></use></body></html>')
  })

  it('does not append HTML outside bodyless compiled Astro modules', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    const transformed = await plugin.transform.handler.call(
      { ...context.hooks, environment: { config: { consumer: 'server' } } },
      'import { render } from "astro/compiler-runtime"; export default render`<use href="#foo/check"></use>`',
      path.join(root, 'src/pages/index.astro'),
    )

    expect(transformed).toBeNull()
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

  it('injects into HTML assets when transformIndexHtml is not called', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<html><body><svg><use href="#foo/check"></use></svg></body></html>',
      },
    }

    await plugin.generateBundle.call(context.hooks, {}, bundle)

    expect(bundle['index.html'].source).not.toContain('data-vite-plugin-heroicons')
    expect(bundle['index.html'].source).toContain('id="foo/check"')
    expect(context.emitted[0].source).not.toContain('data-vite-plugin-heroicons')
  })

  it('collapses duplicate generated sprites in build output', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.configResolved({ root, command: 'build' })
    plugin.buildStart()

    const context = createContext()
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<html><body><use href="#foo/check"></use><svg class="hidden" data-vite-plugin-heroicons></svg><svg class="hidden" data-vite-plugin-heroicons=""></svg></body></html>',
      },
    }

    await plugin.generateBundle.call(context.hooks, {}, bundle)

    const html = bundle['index.html'].source
    expect(html.match(/<svg class="hidden"/g) ?? []).toHaveLength(1)
    expect(html.match(/<symbol id="foo\/check"/g) ?? []).toHaveLength(1)
    expect(html).not.toContain('data-vite-plugin-heroicons')
  })

  it('does not add a transformIndexHtml tag when a generated sprite already exists', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.configResolved({ root, command: 'build' })
    plugin.buildStart()
    plugin.transform.handler('<use href="#foo/check"></use>', '/src/app.js', { ssr: false })

    const context = createContext()
    const transformed = await plugin.transformIndexHtml.handler.call(
      context.hooks,
      '<html><body><svg class="hidden" data-vite-plugin-heroicons></svg><svg class="hidden" data-vite-plugin-heroicons=""></svg></body></html>',
      { filename: '/index.html', path: '/index.html' },
    )

    expect(typeof transformed).toBe('string')
    expect(transformed.match(/<svg class="hidden"/g) ?? []).toHaveLength(1)
    expect(transformed.match(/<symbol id="foo\/check"/g) ?? []).toHaveLength(1)
    expect(transformed).not.toContain('data-vite-plugin-heroicons')
  })

  it('injects into framework HTML responses in dev', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    let middleware
    plugin.configureServer.handler.call(context.hooks, {
      middlewares: {
        use(handler) {
          middleware = handler
        },
      },
    })

    const headers = new Map()
    let responseBody
    const finished = new Promise((resolve) => {
      const response = {
        statusCode: 200,
        headersSent: false,
        getHeader(name) {
          return headers.get(name)
        },
        setHeader(name, value) {
          headers.set(name, value)
        },
        write() {},
        end(chunk) {
          responseBody = Buffer.from(chunk).toString('utf8')
          resolve()
        },
      }

      middleware(
        { method: 'GET', headers: { accept: 'text/html' }, url: '/' },
        response,
        () => {
          response.setHeader('content-type', 'text/html; charset=utf-8')
          response.write('<html><body><svg>')
          response.end('<use href="#foo/check"></use></svg></body></html>')
        },
      )
    })

    await finished
    expect(responseBody).not.toContain('data-vite-plugin-heroicons')
    expect(responseBody).toContain('id="foo/check"')
  })

  it('provides a response transformer virtual module for metaframeworks', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'check', solidSvg)
    await addFile(root, 'src/page.svelte', '<svg><use href="#foo/check"></use></svg>')

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    const resolvedId = plugin.resolveId('virtual:@newlogic-digital/vite-plugin-heroicons')
    const moduleCode = await plugin.load.call(context.hooks, resolvedId)
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleCode).toString('base64')}`
    const { injectHeroicons } = await import(moduleUrl)
    const response = await injectHeroicons(
      new Response('<html><body><svg><use href="#foo/check"></use></svg><svg class="hidden" data-vite-plugin-heroicons></svg><svg class="hidden" data-vite-plugin-heroicons=""></svg></body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
      '/',
    )
    const html = await response.text()

    expect(html).not.toContain('data-vite-plugin-heroicons')
    expect(html).toContain('id="foo/check"')
    expect(html.match(/<svg class="hidden"/g) ?? []).toHaveLength(1)
  })

  it('registers as an Astro integration and post-processes static output', async () => {
    const root = await createTempRoot()
    const outputDir = path.join(root, 'dist')
    await addIcon(root, 'icons', 'check', solidSvg)
    await addFile(root, 'dist/index.html', '<html><body><svg><use href="#foo/check"></use></svg></body></html>')

    const plugin = heroicons({ iconSets: { foo: 'icons' }, emitFile: true })
    const updates = []
    const middlewares = []

    plugin.hooks['astro:config:setup']({
      config: { vite: {} },
      updateConfig(update) {
        updates.push(update)
      },
      addMiddleware(middleware) {
        middlewares.push(middleware)
      },
    })
    plugin.hooks['astro:config:done']({
      config: {
        root: pathToFileURL(`${root}/`),
        srcDir: pathToFileURL(`${path.join(root, 'src')}/`),
      },
    })
    plugin.configResolved({ root })
    plugin.buildStart()

    const warnings = []
    await plugin.hooks['astro:build:done']({
      dir: pathToFileURL(`${outputDir}/`),
      logger: { warn: warning => warnings.push(warning) },
    })

    const html = await fsPromises.readFile(path.join(outputDir, 'index.html'), 'utf8')
    const sprite = await fsPromises.readFile(path.join(outputDir, 'heroicons.svg'), 'utf8')

    expect(updates[0].vite.plugins).toContain(plugin)
    expect(middlewares[0].order).toBe('post')
    expect(fileURLToPath(middlewares[0].entrypoint).endsWith('/astro/middleware.js')).toBe(true)
    expect(warnings).toHaveLength(0)
    expect(html).not.toContain('data-vite-plugin-heroicons')
    expect(html).toContain('id="foo/check"')
    expect(sprite).toContain('id="foo/check"')
    expect(sprite).not.toContain('data-vite-plugin-heroicons')
  })

  it('does not register a second Vite instance when Astro already has the plugin', async () => {
    const root = await createTempRoot()
    const outputDir = path.join(root, 'dist')
    await addIcon(root, 'icons', 'check', solidSvg)
    await addFile(root, 'src/page.astro', '<use href="#foo/check"></use>')
    await addFile(root, 'dist/index.html', '<html><body><svg class="hidden" data-vite-plugin-heroicons></svg></body></html>')

    const configuredPlugin = heroicons({ iconSets: { foo: 'icons' } })
    const integration = heroicons({ iconSets: { foo: 'icons' } })
    const updates = []
    const middlewares = []

    integration.hooks['astro:config:setup']({
      config: { vite: { plugins: [configuredPlugin] } },
      updateConfig(update) {
        updates.push(update)
      },
      addMiddleware(middleware) {
        middlewares.push(middleware)
      },
    })
    integration.hooks['astro:config:done']({
      config: {
        root: pathToFileURL(`${root}/`),
        srcDir: pathToFileURL(`${path.join(root, 'src')}/`),
      },
    })
    await integration.hooks['astro:build:done']({
      dir: pathToFileURL(`${outputDir}/`),
      logger: { warn() {} },
    })

    const html = await fsPromises.readFile(path.join(outputDir, 'index.html'), 'utf8')

    expect(updates).toHaveLength(0)
    expect(middlewares).toHaveLength(1)
    expect(html.match(/<svg class="hidden"/g) ?? []).toHaveLength(1)
    expect(html).toContain('id="foo/check"')
    expect(html).not.toContain('data-vite-plugin-heroicons')
  })

  it('skips the standalone sprite file by default when used as an Astro integration', async () => {
    const root = await createTempRoot()
    const outputDir = path.join(root, 'dist')
    await addIcon(root, 'icons', 'check', solidSvg)
    await addFile(root, 'dist/index.html', '<html><body><svg><use href="#foo/check"></use></svg></body></html>')

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.hooks['astro:config:setup']({
      config: { vite: {} },
      updateConfig() {},
      addMiddleware() {},
    })
    plugin.configResolved({ root })
    plugin.buildStart()

    await plugin.hooks['astro:build:done']({
      dir: pathToFileURL(`${outputDir}/`),
      logger: { warn() {} },
    })

    const html = await fsPromises.readFile(path.join(outputDir, 'index.html'), 'utf8')
    expect(html).toContain('id="foo/check"')
    await expect(fsPromises.access(path.join(outputDir, 'heroicons.svg'))).rejects.toThrow()

    const context = createContext()
    await plugin.generateBundle.call(context.hooks, {}, {})
    expect(context.emitted).toHaveLength(0)
  })

  it('streams non-HTML responses in dev without buffering', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'check', solidSvg)

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    let middleware
    plugin.configureServer.handler.call(context.hooks, {
      middlewares: {
        use(handler) {
          middleware = handler
        },
      },
    })

    const headers = new Map()
    const writtenChunks = []
    let endedBody
    const response = {
      statusCode: 200,
      headersSent: false,
      getHeader(name) {
        return headers.get(name)
      },
      setHeader(name, value) {
        headers.set(name, value)
      },
      write(chunk) {
        writtenChunks.push(Buffer.from(chunk).toString('utf8'))
        return true
      },
      end(chunk) {
        endedBody = chunk == null ? '' : Buffer.from(chunk).toString('utf8')
      },
    }

    middleware(
      { method: 'GET', headers: { accept: '*/*' }, url: '/module.js' },
      response,
      () => {
        response.setHeader('content-type', 'application/javascript')
        response.write('const a = 1\n')
        expect(writtenChunks).toEqual(['const a = 1\n'])
        response.write('const b = 2\n')
        response.end('export default a + b\n')
      },
    )

    expect(writtenChunks).toEqual(['const a = 1\n', 'const b = 2\n'])
    expect(endedBody).toBe('export default a + b\n')
  })

  it('keeps icons from scanned source files across hot updates', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'check', solidSvg)
    const sourcePath = path.join(root, 'src/parts/menu.latte')
    await addFile(root, 'src/parts/menu.latte', '<svg><use href="#foo/check"></use></svg>')

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    await plugin.load.call(context.hooks, plugin.resolveId('virtual:@newlogic-digital/vite-plugin-heroicons'))

    await plugin.hotUpdate({
      file: sourcePath,
      type: 'update',
      read: () => fsPromises.readFile(sourcePath, 'utf8'),
    })

    const bundleContext = createContext()
    await plugin.generateBundle.call(bundleContext.hooks, {}, {})

    expect(bundleContext.emitted).toHaveLength(1)
    expect(bundleContext.emitted[0].source).toContain('id="foo/check"')
  })

  it('injects sprites containing replacement patterns verbatim', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'money', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><title>$& $\' costs</title><path d="M0 0h20v20H0z"/></svg>')

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    const bundle = {
      'index.html': {
        type: 'asset',
        fileName: 'index.html',
        source: '<html><body><svg><use href="#foo/money"></use></svg></body></html>',
      },
    }

    await plugin.generateBundle.call(context.hooks, {}, bundle)

    expect(bundle['index.html'].source).toContain('$& $\' costs')
    expect(bundle['index.html'].source).toContain('</body></html>')
  })

  it('follows symlinked directories when scanning framework sources', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'check', solidSvg)
    await addFile(root, 'shared/parts/menu.latte', '<svg><use href="#foo/check"></use></svg>')
    await fsPromises.mkdir(path.join(root, 'src'), { recursive: true })
    await fsPromises.symlink(path.join(root, 'shared'), path.join(root, 'src/shared'), 'dir')

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    const moduleCode = await plugin.load.call(context.hooks, plugin.resolveId('virtual:@newlogic-digital/vite-plugin-heroicons'))

    expect(moduleCode).toContain('foo/check')
    expect(moduleCode).toContain('<symbol')
  })

  it('skips oversized files when scanning framework sources', async () => {
    const root = await createTempRoot()
    await addIcon(root, 'icons', 'check', solidSvg)
    await addIcon(root, 'icons', 'star', solidSvg)
    await addFile(root, 'src/small.latte', '<svg><use href="#foo/check"></use></svg>')
    await addFile(root, 'src/huge.json', `${' '.repeat(5 * 1024 * 1024)}"<use href=\\"#foo/star\\">"`)

    const plugin = heroicons({ iconSets: { foo: 'icons' } })
    plugin.configResolved({ root })
    plugin.buildStart()

    const context = createContext()
    const moduleCode = await plugin.load.call(context.hooks, plugin.resolveId('virtual:@newlogic-digital/vite-plugin-heroicons'))

    expect(moduleCode).toContain('foo/check')
    expect(moduleCode).not.toContain('foo/star')
    expect(context.warnings).toHaveLength(0)
  })
})
