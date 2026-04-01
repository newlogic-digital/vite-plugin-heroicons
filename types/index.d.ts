import type { Plugin } from 'vite'

export type HeroiconsIconSetPath = string | string[]
export type HeroiconsPathPattern = string | RegExp

export interface HeroiconsOptions {
  fileName?: string
  className?: string
  content?: string | string[]
  inject?: boolean
  injectExclude?: HeroiconsPathPattern | HeroiconsPathPattern[]
  iconSets?: Record<string, HeroiconsIconSetPath>
}

export default function heroicons(options?: HeroiconsOptions): Plugin
