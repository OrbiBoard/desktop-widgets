const { BrowserWindow, screen, ipcMain, shell } = require('electron');
const path = require('path');

let widgetWindow = null;
let pluginApi = null;
let ipcInited = false;

function initIPC() {
  if (ipcInited) return;
  ipcInited = true;

  ipcMain.on('desktop-widgets:set-ignore-mouse', (event, ignore) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && win === widgetWindow && !win.isDestroyed()) {
      if (ignore) {
        win.setIgnoreMouseEvents(true, { forward: true });
      } else {
        win.setIgnoreMouseEvents(false);
      }
    }
  });

  ipcMain.handle('desktop-widgets:get-components', async (event) => {
    if (pluginApi && pluginApi.components && pluginApi.components.list) {
      try {
        const res = await pluginApi.components.list(); // List all components
        return res;
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    return { ok: false, error: 'API not ready' };
  });

  ipcMain.handle('desktop-widgets:load-config', () => {
    if (pluginApi && pluginApi.store) {
      return pluginApi.store.getAll() || {};
    }
    return {};
  });

  ipcMain.handle('desktop-widgets:save-config', (event, config) => {
    if (pluginApi && pluginApi.store) {
      pluginApi.store.setAll(config);
      return { ok: true };
    }
    return { ok: false, error: 'Store API not ready' };
  });
  
  ipcMain.handle('desktop-widgets:get-component-config', (event, componentId) => {
      // This might be useful if we want to fetch specific component defaults?
      // For now, the frontend manages the merged config.
      return {}; 
  });

  ipcMain.handle('desktop-widgets:call-plugin', async (event, { pluginId, fn, args }) => {
    if (pluginApi && pluginApi.call) {
        return await pluginApi.call(pluginId, fn, args);
    }
    return { ok: false, error: 'API not ready' };
  });

  ipcMain.handle('desktop-widgets:open-path', async (event, filePath) => {
      try {
          await shell.openPath(filePath);
          return { ok: true };
      } catch (e) {
          return { ok: false, error: e.message };
      }
  });

  ipcMain.on('desktop-widgets:set-shape', (event, rects) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && win === widgetWindow && !win.isDestroyed()) {
      try {
        // Ensure rects are integers
        const validRects = rects.map(r => ({
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height)
        }));
        win.setShape(validRects);
      } catch (e) {
        console.error('Failed to set window shape:', e);
      }
    }
  });
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.bounds;

  widgetWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    type: 'desktop', // Changed to desktop to better support background behavior
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      webviewTag: true,
      enableRemoteModule: true // Ensure remote module is enabled if needed, though we use IPC
    }
  });

  widgetWindow.loadFile(path.join(__dirname, 'index.html'));

  // Initial state: do not ignore mouse events (let setShape handle transparency)
  widgetWindow.setIgnoreMouseEvents(false);

  // Pin to desktop (WorkerW) using Plugin API
  // Add a small delay to ensure window handle is ready and stable
  setTimeout(() => {
    if (pluginApi && pluginApi.desktop && pluginApi.desktop.attachToDesktop) {
        const res = pluginApi.desktop.attachToDesktop(widgetWindow);
        if (!res || !res.ok) {
            console.error('Failed to attach to desktop:', res ? res.error : 'Unknown error');
        } else {
            console.log('Successfully attached widget window to desktop.');
        }
    } else {
        console.error('Desktop API not available, widgets may not stick to desktop background.');
    }
  }, 500);

  widgetWindow.on('closed', () => {
    widgetWindow = null;
  });
}

module.exports = {
  name: '桌面小组件',
  init: (api) => {
    pluginApi = api;
    initIPC();
    createWidgetWindow();
  },
  functions: {
    toggleEditMode: () => {
      if (!widgetWindow || widgetWindow.isDestroyed()) {
        createWidgetWindow();
      }
      
      const send = () => {
        try { widgetWindow.webContents.send('toggle-edit-mode'); } catch(e) {}
      };

      if (widgetWindow.webContents.isLoading()) {
         widgetWindow.webContents.once('did-finish-load', send);
      } else {
         send();
      }
      
      widgetWindow.show();
    }
  }
};
