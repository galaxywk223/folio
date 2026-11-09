import fs from 'node:fs'
import { defaultSettings, normalizeSettings } from '../shared/settings'
import type { AppSettings } from '../shared/settings'

export function readSettings(path: string): AppSettings {
  try { return normalizeSettings(JSON.parse(fs.readFileSync(path, 'utf8'))) } catch { return { ...defaultSettings } }
}

export function writeSettings(path: string, value: AppSettings): void {
  fs.writeFileSync(path, JSON.stringify(value, null, 2))
}
