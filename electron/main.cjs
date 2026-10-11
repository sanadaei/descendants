const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const appRoot = path.resolve(__dirname, '..');
const distDir = path.join(appRoot, 'dist');
let mainWindow = null;

async function runGeneratedWorldE2E(win) {
  const output = process.env.DESCENDANTS_GENERATED_E2E_OUTPUT;
  if (!output) return false;
  const screenshot = process.env.DESCENDANTS_GENERATED_E2E_SCREENSHOT;
  const screenshotDir = process.env.DESCENDANTS_PDA_E2E_DIR;
  let result = null;
  let lastError = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      result = await win.webContents.executeJavaScript(`(() => {
        const shell = document.querySelector('.desc-pda-hardware');
        const nav = [...document.querySelectorAll('[data-action="pda-tab"][data-pda-tab]')];
        return {
          ready: Boolean(shell && nav.length === 8),
          title: document.title,
          navCount: nav.length,
          activeTab: document.querySelector('.desc-pda-tabs button.active')?.dataset.pdaTab ?? '',
          studioLinks: document.querySelectorAll('a[href*="studio"],a[href*="authoring"]').length,
          commandCenter: {
            priorities: document.querySelectorAll('.desc-daily-priority').length,
            resourceCards: document.querySelectorAll('.desc-daily-resource-summary article').length,
            readiness: document.querySelector('.desc-daily-readiness')?.getAttribute('data-readiness') ?? '',
            executePresent: Boolean(document.querySelector('[data-action="execute-plan"]')),
          },
        };
      })()`);
      if (result?.ready) break;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!result?.ready) throw lastError ?? new Error('Descendants PDA shell did not become ready.');

  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const capture = async (name) => {
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (screenshotDir) fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  await capture('daily-command-normal');
  await capture('task');

  const originalBounds = win.getContentBounds();
  win.setContentSize(1280, 720);
  await new Promise((resolve) => setTimeout(resolve, 180));
  await capture('daily-command-1280x720');
  result.compactContentBounds = win.getContentBounds();
  result.compactNoHorizontalOverflow = await win.webContents.executeJavaScript(`(() => {
    const viewport = document.querySelector('.desc-pda-content');
    return Boolean(viewport && viewport.scrollWidth <= viewport.clientWidth + 1);
  })()`);
  win.setContentSize(originalBounds.width, originalBounds.height);
  await new Promise((resolve) => setTimeout(resolve, 180));

  const tabs = ['body','knowledge','inventory','chronicle','residents','map','system'];
  const reached = {};
  for (const tab of tabs) {
    reached[tab] = await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-action="pda-tab"][data-pda-tab="${tab}"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await capture(tab);
  }
  result.reached = reached;
  result.bodyViewReached = Boolean(reached.body);
  result.activeTab = await win.webContents.executeJavaScript(`document.querySelector('.desc-pda-tabs button.active')?.dataset.pdaTab ?? ''`);
  result.noHorizontalOverflow = await win.webContents.executeJavaScript(`(() => {
    const viewport = document.querySelector('.desc-pda-content');
    return Boolean(viewport && viewport.scrollWidth <= viewport.clientWidth + 1);
  })()`);
  if (screenshot) fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  app.quit();
  return true;
}


function secureWindowOptions() {
  return {
    backgroundColor: '#070a08',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  };
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    title: `The Descendants of Criminals — ${app.getVersion()}`,
    ...secureWindowOptions(),
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await mainWindow.loadFile(path.join(distDir, 'index.html'));
  if (await runGeneratedWorldE2E(mainWindow)) return;
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createMainWindow).catch((error) => {
  dialog.showErrorBox('起動エラー', error instanceof Error ? error.message : String(error));
  app.quit();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createMainWindow(); });
