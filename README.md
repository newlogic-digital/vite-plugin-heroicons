<a href="https://npmjs.com/package/@newlogic-digital/vite-plugin-heroicons"><img src="https://img.shields.io/npm/v/@newlogic-digital/vite-plugin-heroicons.svg" alt="npm package"></a>
<a href="https://nodejs.org/en/about/releases/"><img src="https://img.shields.io/node/v/@newlogic-digital/vite-plugin-heroicons.svg" alt="node compatility"></a>

# ⚡️💡 Vite Plugin Heroicons

Vite plugin that collects Heroicons `<use href="#heroicons-*/*">` references, injects a shared SVG sprite into HTML, and emits heroicons.svg at build time.

```js
import heroicons from '@newlogic-digital/vite-plugin-heroicons'

export default {
  plugins: [
    heroicons()
  ]
}
```

### Requirements

- [Node.js LTS (24.x)](https://nodejs.org/en/download/)
- [Vite](https://vitejs.dev/)
