import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import updaterPackage from 'electron-updater'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../server/server.mjs'
import { UpdateManager } from './updater'

const { autoUpdater } = updaterPackage
const __dirname = dirname(fileURLToPath(import.meta.url))

const localAppData = process.env.LOCALAPPDATA || app.getPath('appData')
const dataRoot = process.env.FOLIO_DATA_DIR
  || (app.isPackaged ? join(localAppData, 'Folio') : join(app.getAppPath(), 'data'))

app.setPath('userData', join(localAppData, 'FolioApp'))

let mainWindow: BrowserWindow | null = null
let closeServer: (() => void) | null = null
let updates: UpdateManager | null = null
let apiPort = 0
let quitting = false

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  void app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('Folio 启动失败', error instanceof Error ? error.message : String(error))
    app.exit(1)
  })
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null)

  const running = await startServer(dataRoot, undefined, { allowDevOrigins: true })
  closeServer = running.close
  apiPort = running.port

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
      quitting = true
    },
    onDownloaded: (status) => { void promptForDownloadedUpdate(status.available_version) },
  })

  ipcMain.handle('folio:updates-get', () => updates?.getStatus())
  ipcMain.handle('folio:updates-check', () => updates?.check())
  ipcMain.handle('folio:updates-install', () => updates?.install())

  mainWindow = await createWindow()
  updates.startAutoCheck()
  mainWindow.on('closed', () => { mainWindow = null })
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = await createWindow()
  })
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    title: 'Folio',
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f7f8fa',
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
  window.once('ready-to-show', () => window.show())

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
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return result.response === 1
}

async function promptForDownloadedUpdate(version: string | null): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || !updates) return
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '更新已下载',
    message: version ? `Folio v${version} 已准备就绪` : '新版 Folio 已准备就绪',
    detail: '重启应用后完成更新安装。',
    buttons: ['稍后', '重启更新'],
    defaultId: 1,
    cancelId: 0,
  })
  if (result.response === 1) await updates.install()
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (quitting) return
  updates?.stop()
  closeServer?.()
  closeServer = null
})
