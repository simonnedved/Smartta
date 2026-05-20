const { app, BrowserWindow, globalShortcut, ipcMain, screen, session } = require("electron");
const path = require("path");

const DEFAULT_SERVER_URL = "http://127.0.0.1:8765";
const MIN_WINDOW_WIDTH = 240;
const MIN_WINDOW_HEIGHT = 320;
const WINDOW_MOVE_STEP = 24;
const WINDOW_RESIZE_STEP = 48;

let mainWindow = null;
let clickThrough = true;

app.commandLine.appendSwitch("disable-renderer-backgrounding");

function readArgValue(name) {
  const prefix = `${name}=`;
  const matched = process.argv.find((arg) => arg.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : null;
}

function getServerUrl() {
  return readArgValue("--server-url") || process.env.SMARTTA_SERVER_URL || DEFAULT_SERVER_URL;
}

function getInitialBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(520, workArea.width);
  const height = Math.min(760, workArea.height);
  return {
    width,
    height,
    x: workArea.x + workArea.width - width - 48,
    y: workArea.y + workArea.height - height - 24,
  };
}

function setClickThrough(enabled) {
  clickThrough = enabled;
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
  mainWindow.webContents.send("desktop-interaction-mode", {
    clickThrough: enabled,
  });
}

function clampBounds(bounds) {
  return {
    ...bounds,
    width: Math.max(MIN_WINDOW_WIDTH, Math.round(bounds.width)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.round(bounds.height)),
  };
}

function resizeWindowBy(deltaWidth, deltaHeight) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const bounds = mainWindow.getBounds();
  mainWindow.setBounds(
    clampBounds({
      ...bounds,
      width: bounds.width + deltaWidth,
      height: bounds.height + deltaHeight,
    }),
    true
  );
}

function moveWindowBy(deltaX, deltaY) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const bounds = mainWindow.getBounds();
  mainWindow.setBounds(
    {
      ...bounds,
      x: bounds.x + deltaX,
      y: bounds.y + deltaY,
    },
    true
  );
}

function resizeWindowTo(width, height) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const bounds = mainWindow.getBounds();
  mainWindow.setBounds(
    clampBounds({
      ...bounds,
      width,
      height,
    }),
    true
  );
}

function registerShortcuts() {
  globalShortcut.register("CommandOrControl+Alt+D", () => {
    setClickThrough(!clickThrough);
  });

  globalShortcut.register("CommandOrControl+Alt+Q", () => {
    app.quit();
  });

  globalShortcut.register("CommandOrControl+Alt+Up", () => {
    moveWindowBy(0, -WINDOW_MOVE_STEP);
  });

  globalShortcut.register("CommandOrControl+Alt+Down", () => {
    moveWindowBy(0, WINDOW_MOVE_STEP);
  });

  globalShortcut.register("CommandOrControl+Alt+Left", () => {
    moveWindowBy(-WINDOW_MOVE_STEP, 0);
  });

  globalShortcut.register("CommandOrControl+Alt+Right", () => {
    moveWindowBy(WINDOW_MOVE_STEP, 0);
  });

  globalShortcut.register("CommandOrControl+Alt+Plus", () => {
    resizeWindowBy(WINDOW_RESIZE_STEP, WINDOW_RESIZE_STEP);
  });

  globalShortcut.register("CommandOrControl+Alt+=", () => {
    resizeWindowBy(WINDOW_RESIZE_STEP, WINDOW_RESIZE_STEP);
  });

  globalShortcut.register("CommandOrControl+Alt+Minus", () => {
    resizeWindowBy(-WINDOW_RESIZE_STEP, -WINDOW_RESIZE_STEP);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...getInitialBounds(),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: true,
    movable: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    show: false,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setMenuBarVisibility(false);

  const url = new URL(getServerUrl());
  url.searchParams.set("desktop", "1");
  mainWindow.loadURL(url.toString());

  mainWindow.once("ready-to-show", () => {
    setClickThrough(clickThrough);
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  session.defaultSession.clearCache().finally(() => {
    createWindow();
    registerShortcuts();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

ipcMain.handle("desktop:set-click-through", (_event, enabled) => {
  setClickThrough(Boolean(enabled));
});

ipcMain.handle("desktop:get-bounds", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }
  return mainWindow.getBounds();
});

ipcMain.handle("desktop:resize-to", (_event, width, height) => {
  resizeWindowTo(Number(width), Number(height));
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
