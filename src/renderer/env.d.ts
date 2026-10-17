import type { FolioBridge } from '../preload/index'

declare global {
  interface Window {
    folio?: FolioBridge
  }
}

export {}
