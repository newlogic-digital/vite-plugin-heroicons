import { promises as fs } from 'node:fs'
import process from 'node:process'
import path from 'node:path'

const PREFIX_TO_DIR = {
  'heroicons-outline': path.resolve(process.cwd(), 'node_modules/heroicons/24/outline'),
  'heroicons-solid': path.resolve(process.cwd(), 'node_modules/heroicons/24/solid'),
  'heroicons-mini': path.resolve(process.cwd(), 'node_modules/heroicons/20/solid'),
  'heroicons-micro': path.resolve(process.cwd(), 'node_modules/heroicons/16/solid'),
}

const ICON_ID_FRAGMENT = 'heroicons-(?:outline|solid|mini|micro)\\/[a-z0-9-]+'
const HEROICONS_USE_RE = new RegExp(
  String.raw`\b(?:xlink:)?href\s*=\s*(?:(["'])#(${ICON_ID_FRAGMENT})\1|#(${ICON_ID_FRAGMENT})(?=[\s>]))`,
  'gi',
)

const BASE_REMOVED_ATTRIBUTES = ['xmlns', 'fill', 'stroke', 'stroke-width', 'aria-hidden', 'data-slot']
const OUTLINE_REMOVED_ATTRIBUTES = ['stroke-linecap', 'stroke-linejoin']

const CLOSE_BODY_RE = /<\/body\s*>/i

const normalizeKey = id => id.split('?')[0]

const extractHeroiconIds = (content) => {
  const ids = new Set()

  if (!content || typeof content !== 'string') {
    return ids
  }

  HEROICONS_USE_RE.lastIndex = 0

  let match

  while ((match = HEROICONS_USE_RE.exec(content)) !== null) {
    const iconId = match[2] ?? match[3]

    if (iconId) {
      ids.add(iconId)
    }
  }

  return ids
}

const upsertFileIcons = (fileToIconIds, key, ids) => {
  if (!ids.size) {
    fileToIconIds.delete(key)
    return
  }

  fileToIconIds.set(key, ids)
}

const collectGlobalIconIds = (fileToIconIds) => {
  const iconIds = new Set()

  for (const ids of fileToIconIds.values()) {
    for (const iconId of ids) {
      iconIds.add(iconId)
    }
  }

  return [...iconIds].sort((left, right) => left.localeCompare(right))
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const removeAttributes = (content, attributes) => {
  let output = content

  for (const attribute of attributes) {
    const pattern = new RegExp(`\\s${escapeRegExp(attribute)}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'gi')
    output = output.replace(pattern, '')
  }

  return output
}

const parseViewBox = (svgOpenTagAttributes) => {
  const match = svgOpenTagAttributes.match(/\bviewBox\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i)

  if (!match) {
    return null
  }

  return match[1] ?? match[2] ?? match[3] ?? null
}

const indentLines = (content, indent) => {
  const trimmed = content.trim()

  if (!trimmed) {
    return ''
  }

  return trimmed
    .split('\n')
    .map(line => `${indent}${line.trimEnd()}`)
    .join('\n')
}

const escapeAttributeValue = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

const buildSymbol = async ({ iconId, symbolCache, missingWarned, warn }) => {
  if (symbolCache.has(iconId)) {
    return symbolCache.get(iconId)
  }

  const [prefix, iconName] = iconId.split('/')
  const iconDir = PREFIX_TO_DIR[prefix]
  const iconPath = iconDir ? path.join(iconDir, `${iconName}.svg`) : null

  if (!iconPath) {
    return null
  }

  let source

  try {
    source = await fs.readFile(iconPath, 'utf8')
  }
  catch {
    if (!missingWarned.has(iconId)) {
      missingWarned.add(iconId)
      warn(`Missing heroicon "${iconId}" at ${iconPath}`)
    }

    return null
  }

  const svgMatch = source.match(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/i)

  if (!svgMatch) {
    if (!missingWarned.has(iconId)) {
      missingWarned.add(iconId)
      warn(`Invalid SVG content for heroicon "${iconId}" at ${iconPath}`)
    }

    return null
  }

  const viewBox = parseViewBox(svgMatch[1])

  if (!viewBox) {
    if (!missingWarned.has(iconId)) {
      missingWarned.add(iconId)
      warn(`Missing viewBox in heroicon "${iconId}" at ${iconPath}`)
    }

    return null
  }

  let innerContent = svgMatch[2]
  innerContent = removeAttributes(innerContent, BASE_REMOVED_ATTRIBUTES)

  if (prefix === 'heroicons-outline') {
    innerContent = removeAttributes(innerContent, OUTLINE_REMOVED_ATTRIBUTES)
  }

  const body = indentLines(innerContent, '        ')
  const symbol = body
    ? `    <symbol id="${iconId}" viewBox="${escapeAttributeValue(viewBox)}">\n${body}\n    </symbol>`
    : `    <symbol id="${iconId}" viewBox="${escapeAttributeValue(viewBox)}"></symbol>`

  symbolCache.set(iconId, symbol)
  return symbol
}

const buildSprite = async ({ iconIds, symbolCache, missingWarned, warn }) => {
  if (!iconIds.length) {
    return ''
  }

  const symbols = []

  for (const iconId of iconIds) {
    const symbol = await buildSymbol({ iconId, symbolCache, missingWarned, warn })

    if (symbol) {
      symbols.push(symbol)
    }
  }

  if (!symbols.length) {
    return ''
  }

  return `<svg class="hidden">\n${symbols.join('\n')}\n</svg>`
}

const injectSpriteToHtml = (html, sprite) => {
  if (!sprite) {
    return html
  }

  if (CLOSE_BODY_RE.test(html)) {
    return html.replace(CLOSE_BODY_RE, `${sprite}\n</body>`)
  }

  return `${html}\n${sprite}`
}

export const heroiconsSpritePlugin = () => {
  const fileToIconIds = new Map()
  const symbolCache = new Map()
  const missingWarned = new Set()
  let buildOutDir = ''
  let isBuildCommand = false

  return {
    name: '@newlogic-digital/vite-plugin-heroicons',
    config(_, env) {
      isBuildCommand = env.command === 'build'
    },
    configResolved(config) {
      buildOutDir = path.resolve(config.root, config.build.outDir)
    },
    buildStart() {
      fileToIconIds.clear()
      symbolCache.clear()
      missingWarned.clear()
    },
    transform(code, id) {
      const key = normalizeKey(id)
      const iconIds = extractHeroiconIds(code)

      upsertFileIcons(fileToIconIds, key, iconIds)

      return null
    },
    handleHotUpdate(ctx) {
      const key = normalizeKey(ctx.file)

      fileToIconIds.delete(key)
      fileToIconIds.delete(`html:${key}`)
    },
    transformIndexHtml: {
      order: 'post',
      async handler(html, ctx) {
        const htmlKey = `html:${normalizeKey(ctx.filename ?? ctx.path)}`
        const htmlIconIds = extractHeroiconIds(html)

        upsertFileIcons(fileToIconIds, htmlKey, htmlIconIds)

        const iconIds = collectGlobalIconIds(fileToIconIds)
        const sprite = await buildSprite({
          iconIds,
          symbolCache,
          missingWarned,
          warn: message => this.warn(message),
        })

        return injectSpriteToHtml(html, sprite)
      },
    },
    async generateBundle() {
      const iconIds = collectGlobalIconIds(fileToIconIds)
      const sprite = await buildSprite({
        iconIds,
        symbolCache,
        missingWarned,
        warn: message => this.warn(message),
      })

      if (!sprite) {
        return
      }

      this.emitFile({
        type: 'asset',
        fileName: 'heroicons.svg',
        source: sprite,
      })
    },
    async closeBundle() {
      if (!isBuildCommand || !buildOutDir) {
        return
      }

      const iconIds = collectGlobalIconIds(fileToIconIds)
      const sprite = await buildSprite({
        iconIds,
        symbolCache,
        missingWarned,
        warn: message => this.warn(message),
      })

      if (!sprite) {
        return
      }

      const outputPath = path.join(buildOutDir, 'heroicons.svg')

      await fs.mkdir(buildOutDir, { recursive: true })
      await fs.writeFile(outputPath, sprite, 'utf8')
    },
  }
}
