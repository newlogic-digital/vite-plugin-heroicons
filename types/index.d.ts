import type { Plugin } from 'vite'

export interface HeroiconsOptions {
  fileName?: string
  className?: string
  inject?: boolean
  iconSets?: Record<string, string>
}

export default function heroicons(options?: HeroiconsOptions): Plugin
