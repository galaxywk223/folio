declare module '../server/server.mjs' {
  export function startServer(
    root: string,
    requestedPort?: number,
    options?: {
      allowDevOrigins?: boolean
      webDir?: string
      legacyAffairsDir?: string
    },
  ): Promise<{
    server: unknown
    store: unknown
    port: number
    close: () => void
  }>
}

declare module '*.mjs'
