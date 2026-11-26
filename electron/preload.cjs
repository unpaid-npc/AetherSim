const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApp", {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});

contextBridge.exposeInMainWorld("aetherDesktop", {
  isElectron: true,
  getSystemHardware: () => ipcRenderer.invoke("system:get-hardware-info"),
});

