const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("smarttaDesktop", {
  setClickThrough(enabled) {
    return ipcRenderer.invoke("desktop:set-click-through", Boolean(enabled));
  },
  getBounds() {
    return ipcRenderer.invoke("desktop:get-bounds");
  },
  resizeTo(width, height) {
    return ipcRenderer.invoke("desktop:resize-to", width, height);
  },
  onInteractionMode(callback) {
    ipcRenderer.on("desktop-interaction-mode", (_event, payload) => {
      callback(payload);
    });
  },
});
