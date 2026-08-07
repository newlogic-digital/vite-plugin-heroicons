import { Buffer } from 'node:buffer'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import MagicString from 'magic-string'
import { normalizePath } from 'vite'

const PLUGIN_NAME = '@newlogic-digital/vite-plugin-heroicons'
const VIRTUAL_MODULE_ID = `virtual:${PLUGIN_NAME}`
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`
const SPRITE_MARKER_ATTRIBUTE = 'data-vite-plugin-heroicons'

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
  emitFile: undefined,
  inject: true,
  injectExclude: /\.json\.[^.]+\.html$/i,
}

const SVG_RE = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/i
const VIEW_BOX_RE = /\bviewBox\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i
const TRANSFORM_ID_RE = /\.(?:[cm]?[jt]sx?|html|json|mdx?|latte|twig|liquid|njk|hbs|pug|vue|svelte|astro|marko)(?:\?.*)?$/i
const HTML_FILE_RE = /\.html?$/i
const HTML_CONTENT_TYPE_RE = /^text\/html(?:\s*;|$)/i
const BASE_STRIP_RE = /\s(?:xmlns|fill|stroke|stroke-width|aria-hidden|data-slot)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const OUTLINE_STRIP_RE = /\s(?:stroke-linecap|stroke-linejoin)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const BODY_CLOSE_RE = /<\/body\s*>/i
const HTML_CLOSE_RE = /<\/html\s*>/i
const SPRITE_MARKER_RE = /\sdata-vite-plugin-heroicons(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi

const SOURCE_SCAN_IGNORES = new Set(['.git', 'dist', 'node_modules'])
const BODYLESS_STATUSES = new Set([101, 204, 205, 304])
const DEV_HTML_REFS_LIMIT = 500
const FILE_IO_CONCURRENCY = 32
const MAX_SCANNED_FILE_SIZE = 4 * 1024 * 1024

const mapWithConcurrency = async (items, limit, task) => {
  const results = Array.from({ length: items.length })
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await task(items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}

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

const sourceToString = source => (
  typeof source === 'string' ? source : Buffer.from(source).toString('utf8')
)

const chunkToBuffer = (chunk, encoding) => (
  Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk, /** @type {BufferEncoding | undefined} */ (typeof encoding === 'string' ? encoding : undefined))
)

const isHtmlContentType = value => HTML_CONTENT_TYPE_RE.test(String(value ?? ''))

const isInsideDirectory = (root, candidate) => {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

const listFiles = async (directory, predicate, files = [], visitedDirs = new Set()) => {
  /** @type {string} */
  let realDirectory
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    realDirectory = await fs.realpath(directory)
    entries = await fs.readdir(directory, { withFileTypes: true })
  }
  catch (error) {
    if (error?.code === 'ENOENT') return files
    throw error
  }

  // Symlinks are followed, so cycle detection has to happen on resolved paths.
  if (visitedDirs.has(realDirectory)) return files
  visitedDirs.add(realDirectory)

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name)
    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()

    if (entry.isSymbolicLink()) {
      try {
        const stats = await fs.stat(filePath)
        isDirectory = stats.isDirectory()
        isFile = stats.isFile()
      }
      catch {
        continue
      }
    }

    if (isDirectory) {
      if (!SOURCE_SCAN_IGNORES.has(entry.name)) await listFiles(filePath, predicate, files, visitedDirs)
      continue
    }

    if (isFile && predicate(filePath)) files.push(filePath)
  }

  return files
}

// The three sprite-matching helpers below are also serialized into the generated
// response module via Function.prototype.toString, so they must stay self-contained:
// only parameters, regex literals, and each other — no module-level bindings.
const findGeneratedSpriteRange = (html, lowerHtml, marker, fromIndex) => {
  let markerIndex = html.indexOf(marker, fromIndex)

  while (markerIndex >= 0) {
    const start = lowerHtml.lastIndexOf('<svg', markerIndex)
    const openingEnd = start >= 0 ? html.indexOf('>', start) : -1

    if (start >= 0 && openingEnd >= markerIndex) {
      const tagRe = /<\/?svg\b[^>]*>/gi
      tagRe.lastIndex = start
      let depth = 0
      let match

      while ((match = tagRe.exec(html)) !== null) {
        if (match.index === start || depth > 0) {
          if (/^<\/svg/i.test(match[0])) depth -= 1
          else if (!/\/>$/.test(match[0])) depth += 1

          if (depth === 0) return { start, end: tagRe.lastIndex }
        }
      }
    }

    markerIndex = html.indexOf(marker, markerIndex + marker.length)
  }

  return null
}

const findGeneratedSpriteRanges = (html, marker, cleanSprite = '') => {
  const ranges = []

  // Lower-casing copies the whole document, so only pay for it once a marker exists.
  if (html.includes(marker)) {
    const lowerHtml = html.toLowerCase()
    let cursor = 0

    while (cursor < html.length) {
      const range = findGeneratedSpriteRange(html, lowerHtml, marker, cursor)
      if (!range) break

      ranges.push(range)
      cursor = range.end
    }
  }

  if (cleanSprite) {
    let spriteIndex = html.indexOf(cleanSprite)
    while (spriteIndex >= 0) {
      ranges.push({ start: spriteIndex, end: spriteIndex + cleanSprite.length })
      spriteIndex = html.indexOf(cleanSprite, spriteIndex + cleanSprite.length)
    }
  }

  ranges.sort((left, right) => left.start - right.start)

  const nonOverlapping = []
  for (const range of ranges) {
    const previous = nonOverlapping.at(-1)
    if (!previous || range.start >= previous.end) nonOverlapping.push(range)
  }

  return nonOverlapping
}

const replaceGeneratedSprites = (html, marker, cleanSprite, replacement) => {
  const ranges = findGeneratedSpriteRanges(html, marker, cleanSprite)
  if (ranges.length === 0) return null

  const chunks = []
  let cursor = 0

  for (const [index, range] of ranges.entries()) {
    chunks.push(html.slice(cursor, range.start))
    if (index === 0) chunks.push(replacement)
    cursor = range.end
  }

  chunks.push(html.slice(cursor))
  return chunks.join('')
}

const findSpriteInsertion = (html) => {
  const bodyClose = BODY_CLOSE_RE.exec(html)
  if (bodyClose) return bodyClose.index

  const htmlClose = HTML_CLOSE_RE.exec(html)
  if (htmlClose) return htmlClose.index

  return html.length
}

const injectSpriteIntoHtml = (html, sprite) => {
  if (!sprite) return html

  const normalized = replaceGeneratedSprites(html, SPRITE_MARKER_ATTRIBUTE, stripSpriteMarker(sprite), sprite)
  if (normalized !== null) return normalized

  const insertAt = findSpriteInsertion(html)
  return `${html.slice(0, insertAt)}${sprite}${html.slice(insertAt)}`
}

const stripSpriteMarker = value => value.replace(SPRITE_MARKER_RE, '')

const isServerTransform = (ctx, options) => (
  ctx?.environment?.config?.consumer === 'server'
  || options?.ssr === true
)

const isAstroComponentTransform = (ctx, options, id, code) => (
  isServerTransform(ctx, options)
  && /\.astro(?:\?.*)?$/i.test(id)
  && code.includes('astro/compiler-runtime')
)

const escapeTemplateLiteralHtml = value => value
  .replaceAll('\\', '\\\\')
  .replaceAll('`', '\\`')
  .replaceAll('${', '\\${')

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

const serializePathPatterns = (patterns) => {
  /** @type {Array<{ type: string, value?: string, source?: string, flags?: string }>} */
  const serialized = []

  for (const pattern of toArray(patterns)) {
    if (typeof pattern === 'string') serialized.push({ type: 'string', value: pattern })
    else if (pattern instanceof RegExp) serialized.push({ type: 'regexp', source: pattern.source, flags: pattern.flags })
  }

  return JSON.stringify(serialized)
}

const createResponseModuleCode = (markedSprite, options) => `
const markedSprite = ${JSON.stringify(markedSprite)}
const sprite = ${JSON.stringify(stripSpriteMarker(markedSprite))}
const marker = ${JSON.stringify(SPRITE_MARKER_ATTRIBUTE)}
const injectEnabled = ${JSON.stringify(Boolean(options.inject))}
const excludedPatterns = ${serializePathPatterns(options.injectExclude)}
const markerPattern = /\\sdata-vite-plugin-heroicons(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?/gi
const bodyClosePattern = /<\\/body\\s*>/i
const htmlClosePattern = /<\\/html\\s*>/i
const htmlContentTypePattern = /^text\\/html(?:\\s*;|$)/i
const skippedStatuses = new Set([101, 204, 205, 304])
const isDev = Boolean(import.meta.env?.DEV)

// Compiled once at module init instead of on every request.
const excludedMatchers = excludedPatterns.map((pattern) => (
  pattern.type === 'string'
    ? (value) => value.includes(pattern.value)
    : ((compiled) => (value) => compiled.test(value))(new RegExp(pattern.source, pattern.flags))
))

const isExcluded = (value) => excludedMatchers.some((matches) => matches(value))

const findGeneratedSpriteRange = ${findGeneratedSpriteRange.toString()}

const findGeneratedSpriteRanges = ${findGeneratedSpriteRanges.toString()}

const replaceGeneratedSprites = ${replaceGeneratedSprites.toString()}

const injectIntoHtml = (html, preserveMarker) => {
  if (!sprite) return html

  const keepMarker = isDev || preserveMarker
  const injectedSprite = keepMarker ? markedSprite : sprite
  const normalized = replaceGeneratedSprites(html, marker, sprite, injectedSprite)
  if (normalized !== null) return keepMarker ? normalized : normalized.replace(markerPattern, '')

  const cleanHtml = keepMarker ? html : html.replace(markerPattern, '')
  if (bodyClosePattern.test(cleanHtml)) return cleanHtml.replace(bodyClosePattern, close => injectedSprite + close)
  if (htmlClosePattern.test(cleanHtml)) return cleanHtml.replace(htmlClosePattern, close => injectedSprite + close)
  return cleanHtml + injectedSprite
}

export const injectHeroicons = async (response, pathname = '', runtimeOptions = {}) => {
  response = await response
  if (!injectEnabled || !sprite || isExcluded(pathname)) return response
  if (skippedStatuses.has(response.status)) return response

  const contentType = response.headers.get('content-type') || ''
  const contentEncoding = response.headers.get('content-encoding') || ''
  if (!htmlContentTypePattern.test(contentType) || (contentEncoding && contentEncoding !== 'identity')) return response

  const html = await response.text()
  const headers = new Headers(response.headers)
  headers.delete('content-length')

  return new Response(injectIntoHtml(html, runtimeOptions.preserveMarker === true), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
`

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
  const codeFilter = { include: [...codeNeedles, 'astro/compiler-runtime'] }

  const state = {
    refsByFile: new Map(),
    refCountById: new Map(),
    symbolById: new Map(),
    warnedIds: new Set(),
    iconDirs: {},
    root: process.cwd(),
    sourceDirs: [],
    command: null,
    astroIntegration: false,
    contentScanned: false,
    sourceScanned: false,
    spriteDirty: true,
    spriteRevision: 0,
    /** @type {{ full: string, inner: string }} */
    sprite: EMPTY_SPRITE,
  }

  /** @type {Set<string>} */
  const devHtmlRefKeys = new Set()

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
    devHtmlRefKeys.clear()
    state.contentScanned = false
    state.sourceScanned = false
    state.spriteDirty = true
    state.spriteRevision += 1
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
    state.spriteRevision += 1
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

    const revision = state.spriteRevision
    const iconIds = [...state.refCountById.keys()].sort()
    if (iconIds.length === 0) return setEmptySprite()

    const symbols = await Promise.all(iconIds.map(iconId => loadSymbol(ctx, iconId)))
    const inner = symbols.filter(Boolean).join('')
    if (revision !== state.spriteRevision) return getSprite(ctx)
    if (!inner) return setEmptySprite()

    const classAttribute = options.className ? ` class="${escapeAttributeValue(options.className)}"` : ''
    state.sprite = {
      full: `<svg${classAttribute} ${SPRITE_MARKER_ATTRIBUTE}="">${inner}</svg>`,
      inner,
    }
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

  const scanSourceRefs = async (ctx) => {
    if (state.sourceScanned || !hrefRe) return
    state.sourceScanned = true

    /** @type {Set<string>} */
    const sourceFiles = new Set()

    try {
      for (const sourceDir of state.sourceDirs) {
        const files = await listFiles(sourceDir, filePath => TRANSFORM_ID_RE.test(filePath))
        for (const filePath of files) sourceFiles.add(filePath)
      }
    }
    catch (error) {
      ctx.warn(`Failed to scan framework source files: ${error.message}`)
      return
    }

    const scanned = await mapWithConcurrency([...sourceFiles], FILE_IO_CONCURRENCY, async (filePath) => {
      try {
        // Guard against pulling oversized data files (e.g. a large JSON) into memory.
        const stats = await fs.stat(filePath)
        if (stats.size > MAX_SCANNED_FILE_SIZE) return null

        const source = await fs.readFile(filePath, 'utf8')
        return { filePath, iconIds: extractIconIds(source, hrefRe, codeNeedles) }
      }
      catch (error) {
        if (error?.code !== 'ENOENT') ctx.warn(`Failed to scan source file "${filePath}": ${error.message}`)
        return null
      }
    })

    // Applied after the parallel reads so ref bookkeeping stays deterministic.
    for (const entry of scanned) {
      if (entry) replaceFileRefs(normalizeIdKey(entry.filePath), entry.iconIds)
    }
  }

  const shouldSkipHtmlInject = (id) => {
    const normalizedId = normalizeIdKey(id)
    return normalizedId.length > 0 && toArray(options.injectExclude).some(pattern => matchesPathPattern(normalizedId, pattern))
  }

  const isScannedSourceFile = filePath => (
    TRANSFORM_ID_RE.test(filePath)
    && state.sourceDirs.some(sourceDir => isInsideDirectory(sourceDir, filePath))
  )

  // As an Astro integration with injection enabled, every page gets the sprite
  // inlined, so the emitted file would be dead weight unless explicitly requested.
  const shouldEmitSpriteFile = () => options.emitFile ?? !(state.astroIntegration && options.inject)

  const trackDevHtmlRefKey = (key) => {
    devHtmlRefKeys.delete(key)
    devHtmlRefKeys.add(key)

    if (devHtmlRefKeys.size <= DEV_HTML_REFS_LIMIT) return

    const oldestKey = devHtmlRefKeys.values().next().value
    devHtmlRefKeys.delete(oldestKey)
    replaceFileRefs(oldestKey, EMPTY_ICON_IDS)
  }

  const transformRenderedHtml = async (ctx, html, id) => {
    const normalizedId = normalizeIdKey(id)
    const refKey = `html:${normalizedId}`
    replaceFileRefs(refKey, extractIconIds(html, hrefRe, codeNeedles))
    trackDevHtmlRefKey(refKey)

    if (!options.inject || shouldSkipHtmlInject(normalizedId)) return html

    const sprite = await getSprite(ctx)
    return stripSpriteMarker(injectSpriteIntoHtml(html, sprite.full))
  }

  const collectBundleHtml = (bundle = {}) => {
    const htmlAssets = []

    for (const output of Object.values(bundle)) {
      if (output.type !== 'asset' || !HTML_FILE_RE.test(output.fileName)) continue

      const html = sourceToString(output.source)
      replaceFileRefs(`html:bundle:${normalizeIdKey(output.fileName)}`, extractIconIds(html, hrefRe, codeNeedles))
      htmlAssets.push({ output, html })
    }

    return htmlAssets
  }

  const writeGeneratedHtml = async (ctx, outputDirectory) => {
    /** @type {string[]} */
    let htmlFiles
    try {
      htmlFiles = await listFiles(outputDirectory, filePath => HTML_FILE_RE.test(filePath))
    }
    catch (error) {
      ctx.warn(`Failed to inspect generated HTML in "${outputDirectory}": ${error.message}`)
      return
    }

    const readPages = await mapWithConcurrency(htmlFiles, FILE_IO_CONCURRENCY, async (filePath) => {
      try {
        const html = await fs.readFile(filePath, 'utf8')
        return { filePath, relativePath: normalizePath(path.relative(outputDirectory, filePath)), html }
      }
      catch (error) {
        ctx.warn(`Failed to read generated HTML "${filePath}": ${error.message}`)
        return null
      }
    })

    // Applied after the parallel reads so ref bookkeeping stays deterministic.
    const generatedPages = readPages.filter(Boolean)
    for (const page of generatedPages) {
      replaceFileRefs(`html:generated:${page.relativePath}`, extractIconIds(page.html, hrefRe, codeNeedles))
    }

    await scanSourceRefs(ctx)
    await scanContentRefs(ctx)
    const sprite = await getSprite(ctx)
    if (!sprite.full) return

    if (options.inject) {
      await mapWithConcurrency(generatedPages, FILE_IO_CONCURRENCY, async (page) => {
        if (shouldSkipHtmlInject(page.relativePath)) return

        const transformed = stripSpriteMarker(injectSpriteIntoHtml(page.html, sprite.full))
        if (transformed === page.html) return

        try {
          await fs.writeFile(page.filePath, transformed, 'utf8')
        }
        catch (error) {
          ctx.warn(`Failed to write generated HTML "${page.filePath}": ${error.message}`)
        }
      })
    }

    if (!shouldEmitSpriteFile()) return

    const assetPath = path.resolve(outputDirectory, options.fileName)
    if (!isInsideDirectory(outputDirectory, assetPath)) {
      ctx.warn(`Skipping emitted sprite "${options.fileName}" because it is outside the build directory.`)
      return
    }

    await fs.mkdir(path.dirname(assetPath), { recursive: true })
    await fs.writeFile(assetPath, stripSpriteMarker(sprite.full), 'utf8')
  }

  const createDevHtmlMiddleware = ctx => (req, res, next) => {
    const method = req.method ?? 'GET'
    const accept = String(req.headers?.accept ?? '')

    if (
      !options.inject
      || method === 'HEAD'
      || (method !== 'GET' && method !== 'POST')
      || (accept && !accept.includes('text/html') && !accept.includes('*/*'))
    ) {
      next()
      return
    }

    const originalWrite = res.write
    const originalEnd = res.end
    const chunks = []
    let ended = false

    const restore = () => {
      res.write = originalWrite
      res.end = originalEnd
    }

    const isPassthroughResponse = () => {
      const contentType = res.getHeader('content-type')
      if (contentType != null && !isHtmlContentType(contentType)) return true

      const contentEncoding = res.getHeader('content-encoding')
      return contentEncoding != null && String(contentEncoding) !== 'identity'
    }

    const flushBuffered = () => {
      restore()
      for (const buffered of chunks.splice(0)) originalWrite.call(res, buffered)
    }

    res.write = function bufferedWrite(chunk, encoding, callback) {
      if (typeof encoding === 'function') {
        callback = encoding
        encoding = undefined
      }

      // Once the headers rule out HTML, hand the response back to keep streaming intact.
      if (isPassthroughResponse()) {
        flushBuffered()
        return originalWrite.call(res, chunk, encoding, callback)
      }

      if (chunk != null) chunks.push(chunkToBuffer(chunk, encoding))
      if (typeof callback === 'function') queueMicrotask(callback)
      return true
    }

    res.end = function bufferedEnd(chunk, encoding, callback) {
      if (ended) return res
      ended = true

      if (typeof chunk === 'function') {
        callback = chunk
        chunk = undefined
        encoding = undefined
      }
      else if (typeof encoding === 'function') {
        callback = encoding
        encoding = undefined
      }

      // Single-shot non-HTML responses never buffered anything, so avoid the extra copy.
      if (isPassthroughResponse()) {
        flushBuffered()
        return originalEnd.call(res, chunk, encoding, callback)
      }

      if (chunk != null) chunks.push(chunkToBuffer(chunk, encoding))

      const originalBody = Buffer.concat(chunks)
      const contentType = res.getHeader('content-type')
      const contentEncoding = String(res.getHeader('content-encoding') ?? '')
      const contentLength = res.getHeader('content-length')
      const canChangeLength = !res.headersSent || contentLength == null
      const shouldTransform = (
        isHtmlContentType(contentType)
        && (!contentEncoding || contentEncoding === 'identity')
        && !BODYLESS_STATUSES.has(res.statusCode)
        && canChangeLength
      )

      Promise.resolve()
        .then(async () => {
          if (!shouldTransform) return originalBody
          const requestPath = req.originalUrl ?? req.url ?? ''
          const html = originalBody.toString('utf8')
          return Buffer.from(await transformRenderedHtml(ctx, html, requestPath))
        })
        .catch((error) => {
          ctx.warn(`Failed to inject the Heroicons sprite into "${req.url ?? ''}": ${error.message}`)
          return originalBody
        })
        .then((body) => {
          restore()
          if (!res.headersSent && contentLength != null) res.setHeader('content-length', body.byteLength)
          originalEnd.call(res, body, callback)
        })

      return res
    }

    try {
      next()
    }
    catch (error) {
      restore()
      throw error
    }
  }

  const plugin = {
    name: PLUGIN_NAME,
    enforce: 'post',
    configResolved(config) {
      state.root = config.root
      state.command = config.command ?? state.command
      if (state.sourceDirs.length === 0) state.sourceDirs = [path.resolve(config.root, 'src')]
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
    configureServer: {
      order: 'pre',
      handler(server) {
        server.middlewares.use(createDevHtmlMiddleware(this))
      },
    },
    resolveId(source) {
      if (source === VIRTUAL_MODULE_ID) return RESOLVED_VIRTUAL_MODULE_ID
      return null
    },
    async load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) return null

      await scanSourceRefs(this)
      await scanContentRefs(this)
      const sprite = await getSprite(this)
      return createResponseModuleCode(sprite.full, options)
    },
    transform: {
      filter: {
        id: TRANSFORM_ID_RE,
        code: codeFilter,
      },
      async handler(code, id, transformOptions) {
        if (!hrefRe) return null
        // Fallback guard for environments that don't support hook filters yet.
        if (!TRANSFORM_ID_RE.test(id)) return null

        const isAstroComponent = isAstroComponentTransform(this, transformOptions, id, code)
        if (isServerTransform(this, transformOptions) && !isAstroComponent) return null

        replaceFileRefs(normalizeIdKey(id), extractIconIds(code, hrefRe, codeNeedles))

        // The Astro integration injects through its middleware. Keeping the
        // compiled-document fallback active as well would create two owners
        // for the same response.
        if (!isAstroComponent || state.astroIntegration) return null

        await scanSourceRefs(this)
        await scanContentRefs(this)
        const sprite = await getSprite(this)
        if (!options.inject || !sprite.full || shouldSkipHtmlInject(id)) return null
        if (!BODY_CLOSE_RE.test(code) && !HTML_CLOSE_RE.test(code)) return null

        const embeddedSprite = state.command === 'serve' || state.astroIntegration
          ? sprite.full
          : stripSpriteMarker(sprite.full)
        const escapedSprite = escapeTemplateLiteralHtml(embeddedSprite)
        const existingRanges = findGeneratedSpriteRanges(code, SPRITE_MARKER_ATTRIBUTE, stripSpriteMarker(escapedSprite))
        if (existingRanges.length === 1 && code.slice(existingRanges[0].start, existingRanges[0].end) === escapedSprite) {
          return null
        }

        const magicCode = new MagicString(code)
        if (existingRanges.length === 0) {
          magicCode.appendLeft(findSpriteInsertion(code), escapedSprite)
        }
        else {
          for (const [index, range] of existingRanges.entries()) {
            if (index === 0) magicCode.overwrite(range.start, range.end, escapedSprite)
            else magicCode.remove(range.start, range.end)
          }
        }

        return {
          code: magicCode.toString(),
          map: magicCode.generateMap({ source: id, hires: 'boundary' }),
        }
      },
    },
    async hotUpdate({ file, type, read }) {
      if (state.sourceScanned && type !== 'delete' && isScannedSourceFile(file)) {
        try {
          const source = await read()
          replaceFileRefs(normalizeIdKey(file), extractIconIds(source, hrefRe, codeNeedles))
          replaceFileRefs(`html:${normalizeIdKey(file)}`, EMPTY_ICON_IDS)
          return
        }
        catch {
          // Fall back to clearing the refs below when the file cannot be read.
        }
      }

      clearFileRefs(file)
    },
    transformIndexHtml: {
      order: 'post',
      async handler(html, ctx) {
        const normalizedId = normalizeIdKey(ctx.filename ?? ctx.path)
        const key = `html:${normalizedId}`
        replaceFileRefs(key, extractIconIds(html, hrefRe, codeNeedles))

        if (!options.inject || state.astroIntegration || shouldSkipHtmlInject(normalizedId)) return html
        if (ctx.server) await ctx.server.waitForRequestsIdle()

        const sprite = await getSprite(this)
        if (!sprite.inner) return html

        const cleanSprite = stripSpriteMarker(sprite.full)
        const normalized = replaceGeneratedSprites(html, SPRITE_MARKER_ATTRIBUTE, cleanSprite, cleanSprite)
        if (normalized !== null) return normalized

        return {
          html,
          tags: [
            {
              tag: 'svg',
              attrs: {
                ...(options.className ? { class: options.className } : {}),
                [SPRITE_MARKER_ATTRIBUTE]: '',
              },
              children: sprite.inner,
              injectTo: 'body',
            },
          ],
        }
      },
    },
    async generateBundle(_outputOptions, bundle = {}) {
      const htmlAssets = collectBundleHtml(bundle)
      await scanContentRefs(this)

      const sprite = await getSprite(this)
      if (!sprite.full) return

      if (options.inject) {
        for (const asset of htmlAssets) {
          if (shouldSkipHtmlInject(asset.output.fileName)) continue
          asset.output.source = stripSpriteMarker(injectSpriteIntoHtml(asset.html, sprite.full))
        }
      }

      if (!shouldEmitSpriteFile()) return

      this.emitFile({
        type: 'asset',
        fileName: options.fileName,
        source: stripSpriteMarker(sprite.full),
      })
    },
  }

  Object.defineProperty(plugin, 'hooks', {
    enumerable: false,
    value: {
      'astro:config:setup': ({ config, updateConfig, addMiddleware }) => {
        state.astroIntegration = true
        const configuredPlugins = toArray(config.vite?.plugins).flat(Infinity)
        const alreadyConfigured = configuredPlugins.some(configuredPlugin => configuredPlugin?.name === PLUGIN_NAME)
        if (!alreadyConfigured) {
          updateConfig({ vite: { plugins: [plugin] } })
        }

        if (options.inject) {
          addMiddleware({
            entrypoint: new URL('./astro/middleware.js', import.meta.url),
            order: 'post',
          })
        }
      },
      'astro:config:done': ({ config }) => {
        const rootDirectory = config.root instanceof URL
          ? fileURLToPath(config.root)
          : path.resolve(state.root, config.root ?? '.')
        const sourceDir = config.srcDir instanceof URL
          ? fileURLToPath(config.srcDir)
          : path.resolve(rootDirectory, config.srcDir ?? 'src')

        state.root = rootDirectory
        state.sourceDirs = [sourceDir]
        state.iconDirs = Object.fromEntries(
          Object.entries(options.iconSets).map(([prefix, iconSetPath]) => [
            prefix,
            resolveIconSetPaths(rootDirectory, iconSetPath),
          ]),
        )
      },
      'astro:build:done': async ({ dir, logger }) => {
        const outputDirectory = dir instanceof URL ? fileURLToPath(dir) : path.resolve(state.root, dir)
        await writeGeneratedHtml({ warn: message => logger.warn(message) }, outputDirectory)
      },
    },
  })

  return plugin
}
