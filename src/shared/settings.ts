export type CloseBehavior = 'tray' | 'quit'
export type ThemeSource = 'system' | 'light' | 'dark'

/** 存在 userData/settings.json 里的设置。开机自启动直接读写系统，不在这里。 */
export type AppSettings = {
  closeBehavior: CloseBehavior
  theme: ThemeSource
}

/** 设置页拿到的完整信息。 */
export type SettingsInfo = AppSettings & {
  openAtLogin: boolean
  autostartSupported: boolean
  version: string
  dataDir: string
}

export type SettingsPatch = Partial<AppSettings> & { openAtLogin?: boolean }

export const defaultSettings: AppSettings = { closeBehavior: 'tray', theme: 'system' }

export function normalizeSettings(raw: unknown): AppSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    closeBehavior: value.closeBehavior === 'quit' ? 'quit' : 'tray',
    theme: value.theme === 'light' || value.theme === 'dark' ? value.theme : 'system',
  }
}
