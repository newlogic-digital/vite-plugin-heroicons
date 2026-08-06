import { injectHeroicons } from 'virtual:@newlogic-digital/vite-plugin-heroicons'

export const onRequest = async (context, next) => (
  injectHeroicons(next(), context.url.pathname, {
    preserveMarker: context.isPrerendered,
  })
)
