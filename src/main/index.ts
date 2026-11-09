import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import updaterPackage from 'electron-updater'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import trayIconPath from '../../assets/icon.png?asset'
import { startServer } from '../server/server.mjs'
import { ensureCliOnPath } from './cli-path'
import { ReminderScheduler } from './reminders'
import type { NavigateTarget } from './reminders'
import { readSettings, writeSettings } from './settings'
import { UpdateManager } from './updater'
import { normalizeSettings } from '../shared/settings'
import type { AppSettings, SettingsInfo, SettingsPatch } from '../shared/settings'

const { autoUpdater } = updaterPackage
const __dirname = dirname(fileURLToPath(import.meta.url))

const localAppData = process.env.LOCALAPPDATA || app.getPath('appData')
const dataRoot = process.env.FOLIO_DATA_DIR
  || (app.isPackaged ? join(localAppData, 'Folio') : join(app.getAppPath(), 'data'))

// 开发运行用单独的目录，不会和已安装的 Folio 抢单实例锁。
app.setPath('userData', join(localAppData, app.isPackaged ? 'FolioApp' : 'FolioApp-dev'))
// 与 build.appId 一致，Windows 通知和任务栏才会显示 Folio 的名称和图标。
// 开发运行用另一个 id：否则 Windows 会把 electron.exe 的图标记到安装版的 id 上。
const appUserModelId = app.isPackaged ? 'com.galaxywk.folio' : 'com.galaxywk.folio.dev'
app.setAppUserModelId(appUserModelId)

let mainWindow: BrowserWindow | null = null
let closeServer: (() => void) | null = null
let updates: UpdateManager | null = null
let tray: Tray | null = null
let apiPort = 0
let installing = false
let isQuitting = false
let trayHintShown = false
let reminders: ReminderScheduler | null = null
let settings: AppSettings = normalizeSettings(null)
const settingsPath = () => join(app.getPath('userData'), 'settings.json')
// 命令行在 Folio 未运行时用 --hidden 启动：只进托盘，不弹出窗口。
const startHidden = process.argv.includes('--hidden')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => { void showMainWindow() })
  void app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('Folio 启动失败', error instanceof Error ? error.message : String(error))
    app.exit(1)
  })
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null)
  settings = readSettings(settingsPath())
  nativeTheme.themeSource = settings.theme

  const running = await startServer(dataRoot, undefined, { allowDevOrigins: true })
  closeServer = running.close
  apiPort = running.port
  reminders = new ReminderScheduler({
    store: running.store,
    statePath: join(app.getPath('userData'), 'reminders.json'),
    onOpen: (target) => { void openTarget(target) },
    onError: (error) => console.error('Folio 提醒检查失败', error),
  })

  ipcMain.handle('folio:get-api-base', () => `http://127.0.0.1:${apiPort}`)
  ipcMain.handle('folio:open-external', async (_event, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
    await shell.openExternal(url)
    return true
  })
  ipcMain.handle('folio:open-data-dir', async () => {
    await shell.openPath(dataRoot)
    return true
  })
  ipcMain.handle('folio:settings-get', () => settingsInfo())
  ipcMain.handle('folio:settings-set', (_event, patch: SettingsPatch) => updateSettings(patch))

  updates = new UpdateManager({
    client: autoUpdater,
    currentVersion: app.getVersion(),
    supported: app.isPackaged,
    notify: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('folio:update-status', status)
    },
    confirmInstall: confirmUpdateInstall,
    beforeInstall: async () => {
      closeServer?.()
      closeServer = null
      installing = true
      isQuitting = true
    },
    onDownloaded: (status) => { void promptForDownloadedUpdate(status.available_version) },
  })

  ipcMain.handle('folio:updates-get', () => updates?.getStatus())
  ipcMain.handle('folio:updates-check', () => updates?.check())
  ipcMain.handle('folio:updates-install', () => updates?.install())

  createTray()
  mainWindow = await createWindow(!startHidden)
  updates.startAutoCheck()
  reminders.start()
  if (app.isPackaged) void ensureCliOnPath(process.resourcesPath).catch(error => console.error('无法把 folio 命令加入 PATH', error))
  app.on('activate', () => { void showMainWindow() })
}

function settingsInfo(): SettingsInfo {
  return {
    ...settings,
    // 开发运行时不注册自启动，否则开机会启动 electron.exe。
    openAtLogin: app.isPackaged && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
    autostartSupported: app.isPackaged,
    version: app.getVersion(),
    dataDir: dataRoot,
  }
}

function updateSettings(patch: SettingsPatch): SettingsInfo {
  const input = patch && typeof patch === 'object' ? patch : {}
  const next = normalizeSettings({ ...settings, ...input })
  if (next.closeBehavior !== settings.closeBehavior || next.theme !== settings.theme) {
    writeSettings(settingsPath(), next)
    settings = next
    nativeTheme.themeSource = next.theme
  }
  if (typeof input.openAtLogin === 'boolean' && app.isPackaged) {
    // 开机时带 --hidden 启动：只进托盘，不弹窗口。
    app.setLoginItemSettings({ openAtLogin: input.openAtLogin, args: ['--hidden'] })
  }
  return settingsInfo()
}

function createTray(): void {
  const icon = nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Folio')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 Folio', click: () => { void showMainWindow() } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
  tray.on('click', () => { void showMainWindow() })
  tray.on('double-click', () => { void showMainWindow() })
}

async function openTarget(target: NavigateTarget): Promise<void> {
  await showMainWindow()
  mainWindow?.webContents.send('folio:navigate', target)
}

async function showMainWindow(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = await createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function createWindow(visible = true): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    title: 'Folio',
    icon: nativeImage.createFromPath(trayIconPath),
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141416' : '#f4f3f0',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('file:')
      || url.startsWith('http://127.0.0.1:')
      || url.startsWith('http://localhost:')
    if (!allowed) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })
  if (process.platform === 'win32') {
    // 把任务栏图标直接写到窗口属性上，不依赖快捷方式和系统的图标缓存。
    window.setAppDetails({
      appId: appUserModelId,
      appIconPath: process.execPath,
      appIconIndex: 0,
      relaunchCommand: '"' + process.execPath + '"' + (app.isPackaged ? '' : ' "' + app.getAppPath() + '"'),
      relaunchDisplayName: 'Folio',
    })
  }
  if (visible) window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (isQuitting) return
    if (settings.closeBehavior === 'quit') {
      isQuitting = true
      app.quit()
      return
    }
    event.preventDefault()
    window.hide()
    if (!trayHintShown && tray) {
      trayHintShown = true
      tray.displayBalloon({
        iconType: 'info',
        title: 'Folio 仍在运行',
        content: '已最小化到托盘，右键托盘图标可退出。',
      })
    }
  })
  window.on('session-end', () => { isQuitting = true })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) await window.loadURL(devUrl)
  else await window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

async function confirmUpdateInstall(): Promise<boolean> {
  const options = {
    type: 'info' as const,
    title: '重启并更新',
    message: '新版本已准备就绪',
    detail: '重启 Folio 后完成更新安装。',
    buttons: ['稍后', '重启更新'],
    defaultId: 1,
    cancelId: 0,
  }
  const result = await showDialog(options)
  return result.response === 1
}

function visibleWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null
}

function showDialog(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const parent = visibleWindow()
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
}

async function promptForDownloadedUpdate(version: string | null): Promise<void> {
  if (!updates) return
  const result = await showDialog({
    type: 'info',
    title: '更新已下载',
    message: version ? `Folio v${version} 已准备就绪` : '新版 Folio 已准备就绪',
    detail: '重启应用后完成更新安装。',
    buttons: ['稍后', '重启更新'],
    defaultId: 1,
    cancelId: 0,
  })
  if (result.response === 1) await updates.install({ confirmed: true })
}

// Folio stays in the tray after its window closes; quit from the tray menu.
app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  isQuitting = true
  tray?.destroy()
  tray = null
  reminders?.stop()
  if (installing) return
  updates?.stop()
  closeServer?.()
  closeServer = null
})
