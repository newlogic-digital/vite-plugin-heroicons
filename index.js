import { Buffer } from 'node:buffer'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { normalizePath } from 'vite'

const DEFAULT_ICON_SETS = {
  'heroicons-outline': 'node_modules/heroicons/24/outline',
  'heroicons-solid': 'node_modules/heroicons/24/solid',
  'heroicons-mini': 'node_modules/heroicons/20/solid',
  'heroicons-micro': 'node_modules/heroicons/16/solid',
}

const DEFAULT_OPTIONS = {
  fileName: 'heroicons.svg',
  className: 'hidden',
  content: undefined,
  inject: true,
  injectExclude: /\.json\.[^.]+\.html$/i,
}

const SVG_RE = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/i
const VIEW_BOX_RE = /\bviewBox\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i
const TRANSFORM_ID_RE = /\.(?:[cm]?[jt]sx?|html|json|latte|twig|liquid|njk|hbs|pug|vue|svelte|astro)(?:\?.*)?$/i
const BASE_STRIP_RE = /\s(?:xmlns|fill|stroke|stroke-width|aria-hidden|data-slot)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const OUTLINE_STRIP_RE = /\s(?:stroke-linecap|stroke-linejoin)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi

const EMPTY_ICON_IDS = new Set()

/** @type {{ full: string, inner: string }} */
const EMPTY_SPRITE = { full: '', inner: '' }

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const escapeAttributeValue = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
const normalizeIdKey = (id = '') => normalizePath(id.split('?')[0])
const toArray = value => (Array.isArray(value) ? value : value == null ? [] : [value])
const resolveIconSetPaths = (root, iconSetPath) => (
  (Array.isArray(iconSetPath) ? iconSetPath : [iconSetPath]).map(candidatePath => (
    path.isAbsolute(candidatePath) ? candidatePath : path.resolve(root, candidatePath)
  ))
)

const isServerTransform = (ctx, options) => (
  ctx?.environment?.config?.consumer === 'server'
  || options?.ssr === true
)

const containsAnyNeedle = (content, needles) => {
  for (const needle of needles) {
    if (content.includes(needle)) return true
  }
  return false
}

const matchesPathPattern = (value, pattern) => {
  if (typeof pattern === 'string') return value.includes(pattern)

  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0
    return pattern.test(value)
  }

  return false
}

const runRipgrep = (args, cwd) => new Promise((resolve, reject) => {
  const child = spawn('rg', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  /** @type {Buffer[]} */
  const stdoutChunks = []
  /** @type {Buffer[]} */
  const stderrChunks = []

  child.stdout.on('data', chunk => stdoutChunks.push(chunk))
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  child.on('error', (error) => {
    const spawnError = /** @type {NodeJS.ErrnoException} */ (error)

    if (spawnError.code === 'ENOENT') {
      reject(new Error('ripgrep (`rg`) was not found in PATH'))
      return
    }

    reject(spawnError)
  })
  child.on('close', (code) => {
    const stdout = Buffer.concat(stdoutChunks).toString('utf8')
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()

    if (code === 0 || code === 1) {
      resolve({ code, stdout, stderr })
      return
    }

    reject(new Error(stderr || `ripgrep exited with code ${code}`))
  })
})

const sameSet = (left, right) => {
  if (!left || !right || left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

const parseViewBox = (attributes) => {
  const match = attributes.match(VIEW_BOX_RE)
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null
}

const buildIconIdPattern = (prefixes) => {
  const prefixPattern = prefixes
    .filter(prefix => typeof prefix === 'string' && prefix.length > 0)
    .map(prefix => escapeRegExp(prefix))
    .join('|')

  return prefixPattern ? `(?:${prefixPattern})\\/[a-z0-9-]+` : null
}

const buildHrefPattern = iconIdPattern => (
  iconIdPattern
    ? String.raw`\b(?:xlink:)?href\s*=\s*(?:(["'])#(${iconIdPattern})\1|#(${iconIdPattern})(?=[\s>]))`
    : null
)

const buildHrefRegExp = (prefixes) => {
  const hrefPattern = buildHrefPattern(buildIconIdPattern(prefixes))
  return hrefPattern ? new RegExp(hrefPattern, 'gi') : null
}

const buildContentHrefPattern = prefixes => buildHrefPattern(buildIconIdPattern(prefixes))

const extractIconIds = (content, hrefRe, needles) => {
  if (
    !hrefRe
    || typeof content !== 'string'
    || content.length === 0
    || !containsAnyNeedle(content, needles)
  ) {
    return EMPTY_ICON_IDS
  }

  const iconIds = new Set()
  hrefRe.lastIndex = 0

  let match
  while ((match = hrefRe.exec(content)) !== null) {
    const iconId = match[2] ?? match[3]
    if (iconId) iconIds.add(iconId)
  }

  return iconIds.size > 0 ? iconIds : EMPTY_ICON_IDS
}

export default function heroicons(userOptions = {}) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...userOptions,
    iconSets: { ...DEFAULT_ICON_SETS, ...(userOptions.iconSets ?? {}) },
  }

  const prefixes = Object.keys(options.iconSets)
  const codeNeedles = prefixes.map(prefix => `#${prefix}/`)
  const hrefRe = buildHrefRegExp(prefixes)
  const contentHrefPattern = buildContentHrefPattern(prefixes)
  const codeFilter = codeNeedles.length <= 1 ? (codeNeedles[0] ?? '#heroicons-') : { include: codeNeedles }

  const state = {
    refsByFile: new Map(),
    refCountById: new Map(),
    symbolById: new Map(),
    warnedIds: new Set(),
    iconDirs: {},
    root: process.cwd(),
    contentScanned: false,
    spriteDirty: true,
    /** @type {{ full: string, inner: string }} */
    sprite: EMPTY_SPRITE,
  }

  const setEmptySprite = () => {
    state.sprite = EMPTY_SPRITE
    state.spriteDirty = false
    return state.sprite
  }

  const resetBuildState = () => {
    state.refsByFile.clear()
    state.refCountById.clear()
    state.symbolById.clear()
    state.warnedIds.clear()
    state.contentScanned = false
    state.spriteDirty = true
    state.sprite = EMPTY_SPRITE
  }

  const updateRefCount = (iconId, delta) => {
    const nextCount = (state.refCountById.get(iconId) ?? 0) + delta
    if (nextCount <= 0) {
      state.refCountById.delete(iconId)
      return
    }
    state.refCountById.set(iconId, nextCount)
  }

  const replaceFileRefs = (fileKey, nextIds) => {
    const previousIds = state.refsByFile.get(fileKey)
    if (!previousIds && nextIds.size === 0) return
    if (sameSet(previousIds, nextIds)) return

    if (previousIds) {
      for (const iconId of previousIds) updateRefCount(iconId, -1)
    }

    if (nextIds.size === 0) {
      state.refsByFile.delete(fileKey)
    }
    else {
      state.refsByFile.set(fileKey, nextIds)
      for (const iconId of nextIds) updateRefCount(iconId, 1)
    }

    state.spriteDirty = true
  }

  const clearFileRefs = (filePath) => {
    const normalized = normalizeIdKey(filePath)
    replaceFileRefs(normalized, EMPTY_ICON_IDS)
    replaceFileRefs(`html:${normalized}`, EMPTY_ICON_IDS)
  }

  const warnOnce = (ctx, iconId, message) => {
    if (state.warnedIds.has(iconId)) return
    state.warnedIds.add(iconId)
    ctx.warn(message)
  }

  const loadSymbol = async (ctx, iconId) => {
    const cached = state.symbolById.get(iconId)
    if (cached) return cached

    const slash = iconId.indexOf('/')
    if (slash <= 0 || slash >= iconId.length - 1) return null

    const prefix = iconId.slice(0, slash)
    const iconName = iconId.slice(slash + 1)
    const iconDirs = state.iconDirs[prefix]
    if (!iconDirs?.length) return null

    let iconPath
    let source
    const searchedPaths = []

    for (const iconDir of iconDirs) {
      iconPath = path.join(iconDir, `${iconName}.svg`)
      searchedPaths.push(iconPath)

      try {
        source = await fs.readFile(iconPath, 'utf8')
        break
      }
      catch (error) {
        if (error?.code === 'ENOENT') continue
        warnOnce(ctx, iconId, `Failed to read icon "${iconId}" at ${iconPath}: ${error.message}`)
        return null
      }
    }

    if (!source) {
      warnOnce(ctx, iconId, `Missing icon "${iconId}" in ${searchedPaths.join(', ')}`)
      return null
    }

    const svgMatch = source.match(SVG_RE)
    if (!svgMatch) {
      warnOnce(ctx, iconId, `Invalid SVG for icon "${iconId}" at ${iconPath}`)
      return null
    }

    const viewBox = parseViewBox(svgMatch[1])
    if (!viewBox) {
      warnOnce(ctx, iconId, `Missing viewBox for icon "${iconId}" at ${iconPath}`)
      return null
    }

    let body = svgMatch[2].replace(BASE_STRIP_RE, '')
    if (prefix === 'heroicons-outline') body = body.replace(OUTLINE_STRIP_RE, '')

    const symbol = `<symbol id="${escapeAttributeValue(iconId)}" viewBox="${escapeAttributeValue(viewBox)}">${body.trim()}</symbol>`
    state.symbolById.set(iconId, symbol)
    return symbol
  }

  const getSprite = async (ctx) => {
    if (!state.spriteDirty) return state.sprite

    const iconIds = [...state.refCountById.keys()].sort()
    if (iconIds.length === 0) return setEmptySprite()

    const symbols = await Promise.all(iconIds.map(iconId => loadSymbol(ctx, iconId)))
    const inner = symbols.filter(Boolean).join('')
    if (!inner) return setEmptySprite()

    const classAttribute = options.className ? ` class="${escapeAttributeValue(options.className)}"` : ''
    state.sprite = { full: `<svg${classAttribute}>${inner}</svg>`, inner }
    state.spriteDirty = false
    return state.sprite
  }

  const resolveContentPatterns = (ctx) => {
    const patterns = []
    for (const rawPattern of toArray(options.content)) {
      if (typeof rawPattern !== 'string' || rawPattern.length === 0) continue

      const pattern = path.isAbsolute(rawPattern)
        ? normalizePath(path.relative(state.root, rawPattern))
        : normalizePath(rawPattern)

      if (pattern.startsWith('../')) {
        ctx.warn(`Skipping content entry "${rawPattern}" because it is outside the Vite root.`)
        continue
      }

      patterns.push(pattern)
    }

    return patterns
  }

  const scanContentRefs = async (ctx) => {
    if (state.contentScanned || !contentHrefPattern) return
    state.contentScanned = true

    if (!options.content) return

    const contentPatterns = resolveContentPatterns(ctx)
    if (contentPatterns.length === 0) return

    const args = [
      '-P',
      '-o',
      '--no-filename',
      '--replace', '$2$3',
      '--no-config',
      '--color=never',
      '--hidden',
      '--follow',
      '--glob', '!**/.git/**',
      '--glob', '!**/node_modules/**',
      '--glob', '!**/dist/**',
      ...contentPatterns.flatMap(pattern => ['--glob', pattern]),
      contentHrefPattern,
      '.',
    ]

    /** @type {{ stdout: string }} */
    let result
    try {
      result = await runRipgrep(args, state.root)
    }
    catch (error) {
      ctx.warn(`Failed to scan content files with ripgrep: ${error.message}`)
      return
    }

    const iconIds = new Set(
      result.stdout
        .split(/\r?\n/)
        .filter(Boolean),
    )

    replaceFileRefs('content:build', iconIds.size > 0 ? iconIds : EMPTY_ICON_IDS)
  }

  const shouldSkipHtmlInject = (id) => {
    const normalizedId = normalizeIdKey(id)
    return normalizedId.length > 0 && toArray(options.injectExclude).some(pattern => matchesPathPattern(normalizedId, pattern))
  }

  return {
    name: '@newlogic-digital/vite-plugin-heroicons',
    enforce: 'post',
    configResolved(config) {
      state.root = config.root
      state.iconDirs = Object.fromEntries(
        Object.entries(options.iconSets).map(([prefix, iconSetPath]) => [
          prefix,
          resolveIconSetPaths(config.root, iconSetPath),
        ]),
      )
    },
    buildStart() {
      resetBuildState()
    },
    transform: {
      filter: {
        id: TRANSFORM_ID_RE,
        code: codeFilter,
      },
      handler(code, id, transformOptions) {
        if (!hrefRe || isServerTransform(this, transformOptions)) return null

        // Fallback guard for environments that don't support hook filters yet.
        if (!TRANSFORM_ID_RE.test(id)) return null

        replaceFileRefs(normalizeIdKey(id), extractIconIds(code, hrefRe, codeNeedles))
        return null
      },
    },
    hotUpdate(options) {
      clearFileRefs(options.file)
    },
    transformIndexHtml: {
      order: 'post',
      async handler(html, ctx) {
        const normalizedId = normalizeIdKey(ctx.filename ?? ctx.path)
        const key = `html:${normalizedId}`
        replaceFileRefs(key, extractIconIds(html, hrefRe, codeNeedles))

        if (!options.inject || shouldSkipHtmlInject(normalizedId)) return html
        if (ctx.server) await ctx.server.waitForRequestsIdle()

        const sprite = await getSprite(this)
        if (!sprite.inner) return html

        return {
          html,
          tags: [
            {
              tag: 'svg',
              attrs: options.className ? { class: options.className } : {},
              children: sprite.inner,
              injectTo: 'body',
            },
          ],
        }
      },
    },
    async generateBundle() {
      await scanContentRefs(this)

      const sprite = await getSprite(this)
      if (!sprite.full) return

      this.emitFile({
        type: 'asset',
        fileName: options.fileName,
        source: sprite.full,
      })
    },
  }
}
