import { promises as fs } from 'node:fs'
import path from 'node:path'
import { normalizePath } from 'vite'

const DEFAULT_ICON_SETS = {
  'heroicons-outline': 'node_modules/heroicons/24/outline',
  'heroicons-solid': 'node_modules/heroicons/24/solid',
  'heroicons-mini': 'node_modules/heroicons/20/solid',
  'heroicons-micro': 'node_modules/heroicons/16/solid',
}

const ICON_ID_FRAGMENT = 'heroicons-(?:outline|solid|mini|micro)\\/[a-z0-9-]+'
const ICON_HREF_RE = new RegExp(
  String.raw`\b(?:xlink:)?href\s*=\s*(?:(["'])#(${ICON_ID_FRAGMENT})\1|#(${ICON_ID_FRAGMENT})(?=[\s>]))`,
  'gi',
)

const SVG_RE = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/i
const VIEW_BOX_RE = /\bviewBox\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i

const TRANSFORM_FILTER_RE = /\.(?:[cm]?[jt]sx?|html|json|latte|twig|liquid|njk|hbs|pug|vue|svelte|astro)(?:\?.*)?$/i
const CLOSE_BODY_RE = /<\/body\s*>/i

const BASE_REMOVED_ATTRIBUTES = ['xmlns', 'fill', 'stroke', 'stroke-width', 'aria-hidden', 'data-slot']
const OUTLINE_REMOVED_ATTRIBUTES = ['stroke-linecap', 'stroke-linejoin']

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const removeAttributes = (content, attributes) => {
  let output = content

  for (const attribute of attributes) {
    const pattern = new RegExp(`\\s${escapeRegExp(attribute)}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'gi')
    output = output.replace(pattern, '')
  }

  return output
}

const escapeAttributeValue = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

const normalizeIdKey = (id = '') => normalizePath(id.split('?')[0])

const indent = (content, prefix = '    ') => content
  .split('\n')
  .map(line => `${prefix}${line}`)
  .join('\n')

const extractHeroiconIds = (content) => {
  const iconIds = new Set()

  if (typeof content !== 'string' || content.length === 0) {
    return iconIds
  }

  ICON_HREF_RE.lastIndex = 0

  let match

  while ((match = ICON_HREF_RE.exec(content)) !== null) {
    const iconId = match[2] ?? match[3]

    if (iconId) {
      iconIds.add(iconId)
    }
  }

  return iconIds
}

const updateReferenceMap = (referenceMap, key, iconIds) => {
  if (iconIds.size === 0) {
    referenceMap.delete(key)
    return
  }

  referenceMap.set(key, iconIds)
}

const collectSortedIconIds = (referenceMap) => {
  const iconIds = new Set()

  for (const fileIconIds of referenceMap.values()) {
    for (const iconId of fileIconIds) {
      iconIds.add(iconId)
    }
  }

  return [...iconIds].sort((left, right) => left.localeCompare(right))
}

const parseViewBox = (svgOpenTagAttributes) => {
  const match = svgOpenTagAttributes.match(VIEW_BOX_RE)

  if (!match) {
    return null
  }

  return match[1] ?? match[2] ?? match[3] ?? null
}

const injectSprite = (html, sprite) => {
  if (!sprite) {
    return html
  }

  if (CLOSE_BODY_RE.test(html)) {
    return html.replace(CLOSE_BODY_RE, `${sprite}\n</body>`)
  }

  return `${html}\n${sprite}`
}

/**
 * @typedef HeroiconsSpritePluginOptions
 * @property {string} [fileName] Output SVG file name in build (default: "heroicons.svg")
 * @property {string} [spriteClass] Class for inline sprite root <svg> (default: "hidden")
 * @property {boolean} [injectToHtml] Inject sprite into transformed HTML (default: true)
 * @property {boolean} [warnOnMissing] Warn once when icon file is missing/invalid (default: true)
 * @property {Record<string, string>} [iconSets] Prefix -> directory mapping
 */

/**
 * @param {HeroiconsSpritePluginOptions} [userOptions]
 * @returns {import('vite').Plugin}
 */
export const heroiconsSpritePlugin = (userOptions = {}) => {
  const options = {
    fileName: 'heroicons.svg',
    spriteClass: 'hidden',
    injectToHtml: true,
    warnOnMissing: true,
    iconSets: { ...DEFAULT_ICON_SETS, ...(userOptions.iconSets ?? {}) },
    ...userOptions,
  }

  const referencesByFile = new Map()
  const symbolByIconId = new Map()
  const warnedIconIds = new Set()

  let resolvedIconSets = {}

  const warnOnce = (pluginContext, iconId, message) => {
    if (!options.warnOnMissing || warnedIconIds.has(iconId)) {
      return
    }

    warnedIconIds.add(iconId)
    pluginContext.warn(message)
  }

  const buildSymbol = async (pluginContext, iconId) => {
    if (symbolByIconId.has(iconId)) {
      return symbolByIconId.get(iconId)
    }

    const [prefix, iconName] = iconId.split('/')
    const iconDir = resolvedIconSets[prefix]

    if (!iconDir) {
      return null
    }

    const iconPath = path.join(iconDir, `${iconName}.svg`)

    let source

    try {
      source = await fs.readFile(iconPath, 'utf8')
    }
    catch {
      warnOnce(pluginContext, iconId, `Missing heroicon "${iconId}" at ${iconPath}`)
      return null
    }

    const svgMatch = source.match(SVG_RE)

    if (!svgMatch) {
      warnOnce(pluginContext, iconId, `Invalid SVG for heroicon "${iconId}" at ${iconPath}`)
      return null
    }

    const viewBox = parseViewBox(svgMatch[1])

    if (!viewBox) {
      warnOnce(pluginContext, iconId, `Missing viewBox for heroicon "${iconId}" at ${iconPath}`)
      return null
    }

    let innerContent = removeAttributes(svgMatch[2], BASE_REMOVED_ATTRIBUTES)

    if (prefix === 'heroicons-outline') {
      innerContent = removeAttributes(innerContent, OUTLINE_REMOVED_ATTRIBUTES)
    }

    const cleanedBody = innerContent
      .trim()
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')

    const symbol = cleanedBody
      ? `<symbol id="${iconId}" viewBox="${escapeAttributeValue(viewBox)}">\n${indent(cleanedBody)}\n</symbol>`
      : `<symbol id="${iconId}" viewBox="${escapeAttributeValue(viewBox)}"></symbol>`

    symbolByIconId.set(iconId, symbol)
    return symbol
  }

  const renderSprite = async (pluginContext) => {
    const iconIds = collectSortedIconIds(referencesByFile)

    if (iconIds.length === 0) {
      return ''
    }

    const symbols = []

    for (const iconId of iconIds) {
      const symbol = await buildSymbol(pluginContext, iconId)

      if (symbol) {
        symbols.push(indent(symbol))
      }
    }

    if (symbols.length === 0) {
      return ''
    }

    return `<svg class="${escapeAttributeValue(options.spriteClass)}">\n${symbols.join('\n')}\n</svg>`
  }

  return {
    name: '@newlogic-digital/vite-plugin-heroicons',
    enforce: 'post',
    sharedDuringBuild: true,
    configResolved(config) {
      const entries = Object.entries(options.iconSets).map(([prefix, iconSetPath]) => {
        const resolvedPath = path.isAbsolute(iconSetPath)
          ? iconSetPath
          : path.resolve(config.root, iconSetPath)

        return [prefix, resolvedPath]
      })

      resolvedIconSets = Object.fromEntries(entries)
    },
    buildStart() {
      referencesByFile.clear()
      symbolByIconId.clear()
      warnedIconIds.clear()
    },
    transform: {
      filter: {
        id: TRANSFORM_FILTER_RE,
      },
      handler(code, id) {
        if (!TRANSFORM_FILTER_RE.test(id)) {
          return null
        }

        updateReferenceMap(referencesByFile, normalizeIdKey(id), extractHeroiconIds(code))

        return null
      },
    },
    handleHotUpdate(ctx) {
      const normalizedFile = normalizeIdKey(ctx.file)

      referencesByFile.delete(normalizedFile)
      referencesByFile.delete(`html:${normalizedFile}`)
    },
    transformIndexHtml: {
      order: 'post',
      async handler(html, ctx) {
        const htmlKey = `html:${normalizeIdKey(ctx.filename ?? ctx.path)}`

        updateReferenceMap(referencesByFile, htmlKey, extractHeroiconIds(html))

        if (!options.injectToHtml) {
          return html
        }

        const sprite = await renderSprite(this)

        return injectSprite(html, sprite)
      },
    },
    async generateBundle() {
      const sprite = await renderSprite(this)

      if (!sprite) {
        return
      }

      this.emitFile({
        type: 'asset',
        fileName: options.fileName,
        source: sprite,
      })
    },
  }
}
