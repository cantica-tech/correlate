"use strict";

/**
 * The Electron app of the parity checks (REQ-000020-sJpO9KMY Requirement 2):
 * one sandboxed window of a fixed size, nothing else. The test drives it
 * through Playwright and loads cttc's page and ours in turn.
 */
const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 900,
    height: 760,
    useContentSize: true,
    resizable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
