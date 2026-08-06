declare module 'virtual:@newlogic-digital/vite-plugin-heroicons' {
  export function injectHeroicons(
    response: Response | Promise<Response>,
    pathname?: string,
    options?: {
      preserveMarker?: boolean
    },
  ): Promise<Response>
}
