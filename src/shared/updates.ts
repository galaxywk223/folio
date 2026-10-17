export type UpdatePhase =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export type UpdateStatus = {
  phase: UpdatePhase
  current_version: string
  available_version: string | null
  download_percent: number | null
  message: string | null
}
