import { promises as fs } from 'node:fs'
import path from 'node:path'
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
  inject: true,
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

const sameSet = (left, right) => {
  if (!left || !right || left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

const containsAnyNeedle = (content, needles) => {
  for (const needle of needles) {
    if (content.includes(needle)) return true
  }
  return false
}

const parseViewBox = (attributes) => {
  const match = attributes.match(VIEW_BOX_RE)
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null
}

const buildHrefRegExp = (prefixes) => {
  const pattern = prefixes
    .filter(prefix => typeof prefix === 'string' && prefix.length > 0)
    .map(prefix => escapeRegExp(prefix))
    .join('|')

  if (!pattern) return null
  const iconIdPattern = `(?:${pattern})\\/[a-z0-9-]+`

  return new RegExp(
    String.raw`\b(?:xlink:)?href\s*=\s*(?:(["'])#(${iconIdPattern})\1|#(${iconIdPattern})(?=[\s>]))`,
    'gi',
  )
}

const extractIconIds = (content, hrefRe) => {
  if (!hrefRe || typeof content !== 'string' || content.length === 0) return EMPTY_ICON_IDS

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
  const codeFilter = codeNeedles.length <= 1 ? (codeNeedles[0] ?? '#heroicons-') : { include: codeNeedles }

  const state = {
    refsByFile: new Map(),
    refCountById: new Map(),
    symbolById: new Map(),
    pendingSymbolById: new Map(),
    warnedIds: new Set(),
    iconDirs: {},
    sortedIds: [],
    sortedIdsDirty: true,
    spriteDirty: true,
    /** @type {{ full: string, inner: string }} */
    sprite: EMPTY_SPRITE,
  }

  const setEmptySprite = () => {
    state.sprite = EMPTY_SPRITE
    state.spriteDirty = false
    return state.sprite
  }

  const markDirty = () => {
    state.sortedIdsDirty = true
    state.spriteDirty = true
  }

  const resetBuildState = () => {
    state.refsByFile.clear()
    state.refCountById.clear()
    state.symbolById.clear()
    state.pendingSymbolById.clear()
    state.warnedIds.clear()
    state.sortedIds = []
    state.sortedIdsDirty = true
    state.spriteDirty = true
    state.sprite = EMPTY_SPRITE
  }

  const updateRefCount = (iconId, delta) => {
    const nextCount = (state.refCountById.get(iconId) ?? 0) + delta
    if (nextCount <= 0) {
      state.refCountById.delete(iconId)
      state.symbolById.delete(iconId)
      state.pendingSymbolById.delete(iconId)
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

    markDirty()
  }

  const getSortedIds = () => {
    if (state.sortedIdsDirty) {
      state.sortedIds = [...state.refCountById.keys()].sort()
      state.sortedIdsDirty = false
    }
    return state.sortedIds
  }

  const warnOnce = (ctx, iconId, message) => {
    if (state.warnedIds.has(iconId)) return
    state.warnedIds.add(iconId)
    ctx.warn(message)
  }

  const loadSymbol = async (ctx, iconId) => {
    if (state.symbolById.has(iconId)) return state.symbolById.get(iconId)

    const pending = state.pendingSymbolById.get(iconId)
    if (pending) return pending

    const loading = (async () => {
      const slash = iconId.indexOf('/')
      if (slash <= 0 || slash >= iconId.length - 1) return null

      const prefix = iconId.slice(0, slash)
      const iconName = iconId.slice(slash + 1)
      const iconDir = state.iconDirs[prefix]
      if (!iconDir) return null

      const iconPath = path.join(iconDir, `${iconName}.svg`)

      let source
      try {
        source = await fs.readFile(iconPath, 'utf8')
      }
      catch {
        warnOnce(ctx, iconId, `Missing heroicon "${iconId}" at ${iconPath}`)
        return null
      }

      const svgMatch = source.match(SVG_RE)
      if (!svgMatch) {
        warnOnce(ctx, iconId, `Invalid SVG for heroicon "${iconId}" at ${iconPath}`)
        return null
      }

      const viewBox = parseViewBox(svgMatch[1])
      if (!viewBox) {
        warnOnce(ctx, iconId, `Missing viewBox for heroicon "${iconId}" at ${iconPath}`)
        return null
      }

      let body = svgMatch[2].replace(BASE_STRIP_RE, '')
      if (prefix === 'heroicons-outline') body = body.replace(OUTLINE_STRIP_RE, '')

      const symbol = `<symbol id="${escapeAttributeValue(iconId)}" viewBox="${escapeAttributeValue(viewBox)}">${body.trim()}</symbol>`
      state.symbolById.set(iconId, symbol)
      return symbol
    })()
      .finally(() => {
        state.pendingSymbolById.delete(iconId)
      })

    state.pendingSymbolById.set(iconId, loading)
    return loading
  }

  const getSprite = async (ctx) => {
    if (!state.spriteDirty) return state.sprite

    const iconIds = getSortedIds()
    if (iconIds.length === 0) return setEmptySprite()

    const symbols = await Promise.all(iconIds.map(iconId => loadSymbol(ctx, iconId)))
    const inner = symbols.filter(Boolean).join('')
    if (!inner) return setEmptySprite()

    const classAttribute = options.className ? ` class="${escapeAttributeValue(options.className)}"` : ''
    state.sprite = { full: `<svg${classAttribute}>${inner}</svg>`, inner }
    state.spriteDirty = false
    return state.sprite
  }

  return {
    name: '@newlogic-digital/vite-plugin-heroicons',
    enforce: 'post',
    configResolved(config) {
      state.iconDirs = Object.fromEntries(
        Object.entries(options.iconSets).map(([prefix, iconSetPath]) => [
          prefix,
          path.isAbsolute(iconSetPath) ? iconSetPath : path.resolve(config.root, iconSetPath),
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
        if (transformOptions?.ssr || !hrefRe) return null
        replaceFileRefs(normalizeIdKey(id), extractIconIds(code, hrefRe))
        return null
      },
    },
    handleHotUpdate(ctx) {
      const normalized = normalizeIdKey(ctx.file)
      replaceFileRefs(normalized, EMPTY_ICON_IDS)
      replaceFileRefs(`html:${normalized}`, EMPTY_ICON_IDS)
    },
    transformIndexHtml: {
      order: 'post',
      async handler(html, ctx) {
        const key = `html:${normalizeIdKey(ctx.filename ?? ctx.path)}`
        const iconIds = containsAnyNeedle(html, codeNeedles)
          ? extractIconIds(html, hrefRe)
          : EMPTY_ICON_IDS

        replaceFileRefs(key, iconIds)
        if (!options.inject) return html

        const sprite = await getSprite(this)
        if (!sprite.inner) return html

        return {
          html,
          tags: [
            {
              tag: 'svg',
              attrs: options.className ? { class: options.className } : {},
              children: sprite.inner,
              injectTo: 'body-prepend',
            },
          ],
        }
      },
    },
    async generateBundle() {
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
