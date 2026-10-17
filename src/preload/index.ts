import { contextBridge, ipcRenderer } from 'electron'
import type { UpdateStatus } from '../shared/updates'

export type FolioBridge = {
  getApiBase: () => Promise<string>
  openExternal: (url: string) => Promise<boolean>
  openDataDir: () => Promise<boolean>
  getUpdateStatus: () => Promise<UpdateStatus>
  checkForUpdates: () => Promise<UpdateStatus>
  installUpdate: () => Promise<{ started: boolean }>
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
}

const bridge: FolioBridge = {
  getApiBase: () => ipcRenderer.invoke('folio:get-api-base'),
  openExternal: (url) => ipcRenderer.invoke('folio:open-external', url),
  openDataDir: () => ipcRenderer.invoke('folio:open-data-dir'),
  getUpdateStatus: () => ipcRenderer.invoke('folio:updates-get'),
  checkForUpdates: () => ipcRenderer.invoke('folio:updates-check'),
  installUpdate: () => ipcRenderer.invoke('folio:updates-install'),
  onUpdateStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status)
    ipcRenderer.on('folio:update-status', listener)
    return () => ipcRenderer.removeListener('folio:update-status', listener)
  },
}

contextBridge.exposeInMainWorld('folio', bridge)
