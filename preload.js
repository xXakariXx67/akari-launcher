const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Navigation & Management
  getInstances: () => ipcRenderer.invoke('get-instances'),
  getInstanceInfo: (name) => ipcRenderer.invoke('get-instance-info', name),
  getMcVersions: () => ipcRenderer.invoke('get-mc-versions'),
  createInstance: (payload) => ipcRenderer.invoke('create-instance', payload),
  deleteInstance: (name) => ipcRenderer.invoke('delete-instance', name),
  
  // Storage & Settings
  getDownloadLocation: () => ipcRenderer.invoke('get-download-location'),
  selectDownloadLocation: () => ipcRenderer.invoke('select-download-location'),
  
  // Game Execution & Logs
  launchInstance: (name) => ipcRenderer.invoke('launch-instance', name),
  openLogsWindow: () => ipcRenderer.invoke('open-logs-window'),
  
  // Log Receiver Listener
  onLogData: (callback) => {
    ipcRenderer.on('log-data', (event, data) => callback(data));
  },

  // Addons & Auth API Placeholders
  getMods: (name) => ipcRenderer.invoke('get-mods', name),
  getResourcepacks: (name) => ipcRenderer.invoke('get-resourcepacks', name),
  getShaders: (name) => ipcRenderer.invoke('get-shaders', name),
  deleteAddon: (payload) => ipcRenderer.invoke('delete-addon', payload),
  searchModrinth: (payload) => ipcRenderer.invoke('search-modrinth', payload),
  downloadAddon: (payload) => ipcRenderer.invoke('download-addon', payload),
  getSavedUser: () => ipcRenderer.invoke('get-saved-user'),
  msLogin: () => ipcRenderer.invoke('ms-login'),
  msLogout: () => ipcRenderer.invoke('ms-logout')
});