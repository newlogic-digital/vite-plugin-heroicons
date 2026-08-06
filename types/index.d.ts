/// <reference path="./virtual.d.ts" />

import type { Plugin } from 'vite'

export type HeroiconsIconSetPath = string | string[]
export type HeroiconsPathPattern = string | RegExp

export interface HeroiconsOptions {
  fileName?: string
  className?: string
  content?: string | string[]
  emitFile?: boolean
  inject?: boolean
  injectExclude?: HeroiconsPathPattern | HeroiconsPathPattern[]
  iconSets?: Record<string, HeroiconsIconSetPath>
}

export interface HeroiconsAstroIntegration {
  name: string
  hooks: {
    'astro:config:setup': (options: any) => void | Promise<void>
    'astro:config:done': (options: any) => void | Promise<void>
    'astro:build:done': (options: any) => void | Promise<void>
  }
}

export default function heroicons(options?: HeroiconsOptions): Plugin & HeroiconsAstroIntegration
