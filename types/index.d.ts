import type { Plugin } from 'vite'

export type HeroiconsIconSetPath = string | string[]

export interface HeroiconsOptions {
  fileName?: string
  className?: string
  inject?: boolean
  iconSets?: Record<string, HeroiconsIconSetPath>
}

export default function heroicons(options?: HeroiconsOptions): Plugin
