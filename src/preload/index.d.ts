import type { PltmApi } from './index'

declare global {
  interface Window {
    pltm: PltmApi
  }
}

export {}
