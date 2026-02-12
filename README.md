<a href="https://npmjs.com/package/@newlogic-digital/vite-plugin-heroicons"><img src="https://img.shields.io/npm/v/@newlogic-digital/vite-plugin-heroicons.svg" alt="npm package"></a>
<a href="https://nodejs.org/en/about/releases/"><img src="https://img.shields.io/node/v/@newlogic-digital/vite-plugin-heroicons.svg" alt="node compatility"></a>

# Vite Plugin Heroicons

Vite plugin that collects Heroicons `<use href="#heroicons-*/*">` references, injects a shared SVG sprite into HTML, and emits heroicons.svg at build time.

```js
import heroicons from '@newlogic-digital/vite-plugin-heroicons'

export default {
  plugins: [
    heroicons()
  ]
}
```

## Options

- `fileName` (`string`, default: `"heroicons.svg"`): emitted asset file name.
- `className` (`string`, default: `"hidden"`): class on generated sprite `<svg>`.
- `inject` (`boolean`, default: `true`): inject sprite into transformed HTML via `transformIndexHtml`.
- `iconSets` (`Record<string, string>`): icon prefix to directory mapping.

## Requirements

- [Node.js LTS (24.x)](https://nodejs.org/en/download/)
- [Vite 8+](https://vitejs.dev/)

## Breaking changes

- Plugin uses default export only.
- `spriteClass` was renamed to `className`.
- `injectToHtml` was renamed to `inject`.
- `warnOnMissing` was removed.
