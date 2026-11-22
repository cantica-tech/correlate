/**
 * Render the app's icon (`renderer/src/icons/correlator-app.svg`) to
 * `resources/icon.png`, 1024 px square, for electron-builder, which makes
 * each system's icon from it (REQ-000054-sJpO9KMY). Run with Electron:
 * `npm run icon`; the PNG is committed.
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SIZE = 1024;
const svg = fs.readFileSync(
  path.join(__dirname, "../renderer/src/icons/correlator-app.svg"),
  "utf8",
);
const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:${SIZE}px;height:${SIZE}px">${svg.replace("<svg ", `<svg width="${SIZE}" height="${SIZE}" `)}</div>
</body></html>`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = path.join(__dirname, "../resources/icon.png");
  fs.writeFileSync(out, image.resize({ width: SIZE, height: SIZE }).toPNG());
  console.log(`wrote ${out} (${image.getSize().width}x${image.getSize().height})`);
  app.quit();
});
