<a href="https://npmjs.com/package/@newlogic-digital/vite-plugin-heroicons"><img src="https://img.shields.io/npm/v/@newlogic-digital/vite-plugin-heroicons.svg" alt="npm package"></a>
<a href="https://nodejs.org/en/about/releases/"><img src="https://img.shields.io/node/v/@newlogic-digital/vite-plugin-heroicons.svg" alt="node compatility"></a>

# Vite Plugin Heroicons

Vite plugin that collects Heroicons `<use href="#heroicons-*/*">` references, injects a shared SVG sprite into HTML, and emits heroicons.svg at build time.

The plugin supports regular Vite HTML entry points as well as metaframeworks that render HTML themselves. In dev it transforms final HTML responses, and during a regular Vite build it also transforms emitted HTML assets.

```js
import heroicons from '@newlogic-digital/vite-plugin-heroicons'

export default {
  plugins: [
    heroicons()
  ]
}
```

## Astro

Use the plugin as an Astro integration. The same `heroicons()` factory registers the underlying Vite plugin and an Astro middleware, so injection works in dev, static builds, and on-demand rendered pages.

```js
// astro.config.mjs
import { defineConfig } from 'astro/config'
import heroicons from '@newlogic-digital/vite-plugin-heroicons'

export default defineConfig({
  integrations: [
    heroicons(),
  ],
})
```

Registration through `vite.plugins` is still supported for existing Astro projects and covers the dev server and compiled Astro documents. Using `integrations` is recommended because it also covers bodyless pages, endpoints, prerendered output, and production SSR through Astro's own lifecycle.

As an integration with `inject` enabled, the standalone `heroicons.svg` asset is not emitted because every page receives the sprite inline; set `emitFile: true` if you also want the file.

## Other metaframeworks

If a framework returns HTML after Vite's build hooks have finished, call the framework-neutral response transformer from its server middleware. For example, in SvelteKit:

```js
// src/hooks.server.js
import { injectHeroicons } from 'virtual:@newlogic-digital/vite-plugin-heroicons'

export const handle = async ({ event, resolve }) => (
  injectHeroicons(resolve(event), event.url.pathname)
)
```

The virtual module accepts a `Response` or `Promise<Response>`, only transforms `text/html`, observes `inject` and `injectExclude`, and is bundled into the framework's server output. Source files under `src` are scanned when this module is loaded; use `content` for templates outside `src`.

## Options

- `fileName` (`string`, default: `"heroicons.svg"`): emitted asset file name.
- `emitFile` (`boolean`): emit the sprite as a standalone asset. Defaults to `true`, except when the plugin runs as an Astro integration with `inject` enabled — pages then get the sprite inlined, so the file is skipped unless you set `emitFile: true`.
- `className` (`string`, default: `"hidden"`): class on generated sprite `<svg>`.
- `content` (`string | string[]`): additional root-relative file paths or glob patterns scanned with ripgrep before the sprite is generated. This is useful for templates outside the Vite `src` directory.
- `inject` (`boolean`, default: `true`): inject the sprite into HTML. This uses `transformIndexHtml` when available and framework-aware fallbacks otherwise.
- `injectExclude` (`string | RegExp | Array<string | RegExp>`, default: `/\.json\.[^.]+\.html$/i`): skip sprite injection for matching HTML output paths. By default this targets JSON endpoints rendered through a template extension such as `basic.json.latte.html`, while still allowing normal HTML pages like `basic.json.html`.
- `iconSets` (`Record<string, string | string[]>`): icon prefix to directory mapping. When you pass an array, the plugin searches directories in order and uses the first matching icon.

```js
heroicons({
  content: ['templates/**/*.{latte,twig}'],
  injectExclude: [/\.json\.[^.]+\.html$/i, /\.modal\./i],
  iconSets: {
    'simpleicons-solid': ['src/icons/simpleicons', 'other-path'],
    'icons-solid': 'src/icons/solid',
    'icons-outline': 'src/icons/outline',
  },
})
```

When using `content`, [`ripgrep`](https://github.com/BurntSushi/ripgrep) must be installed and available as `rg` in your `PATH`.

## Requirements

- [Node.js LTS (20.x)](https://nodejs.org/en/download/)
- [Vite 8+](https://vite.dev/)
- [Astro 5+](https://astro.build/) when used as an Astro integration (Astro 4 is not supported)

## Breaking changes

- Plugin uses default export only.
- `spriteClass` was renamed to `className`.
- `injectToHtml` was renamed to `inject`.
- `warnOnMissing` was removed.
