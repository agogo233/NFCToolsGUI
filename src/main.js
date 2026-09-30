const {execAction} = require('./command')
const {app, BrowserWindow, ipcMain, Menu, nativeTheme, shell} = require('electron')
const {createMainWindow, sendToMainWindow} = require('./windows')
const {killProcess, printExitLog, printLog} = require('./execUtils')
const status = require('./status')
const path = require("path");
const buildInfo = require('./buildInfo.json');
const i18n = require('./i18n');

process.env['LIBNFC_SYSCONFDIR'] = app.getPath('userData')

// 异步回调里的异常没人接, 会直接终止主进程, 连带丢掉用户正在编辑的 dump 和正在跑的日志。
// 这里兜底: 记进日志面板并解除"任务进行中", 否则此后每个操作都会弹"设备忙"。
process.on('uncaughtException', (err) => {
    console.error(err)
    status.isRunningTask = false
    printLog(`\n${i18n.getText("log_msg_internal_error")}\n${err && err.message ? err.message : String(err)}\n`)
    printExitLog(1)
})

Menu.setApplicationMenu(null)

ipcMain.handle('minimize-current-window', (event) => {
    BrowserWindow.fromWebContents(event.sender).minimize()
})
ipcMain.handle("close-current-window", (event) => {
    BrowserWindow.fromWebContents(event.sender).close()
})
ipcMain.on('rendered', (event) => {
    BrowserWindow.fromWebContents(event.sender).show()
})

ipcMain.handle('get-app-version', () => {return buildInfo.version})
ipcMain.handle('get-builder', () => {return buildInfo.builder})
ipcMain.handle('exec-action', (event, action, arg) => {
    execAction(action, arg)
})
ipcMain.handle('open-link', (event, url) => {
    // 只放行 https, 其余协议一律拒绝 (file:// 等可被用来打开本地可执行文件)
    if (typeof url !== 'string' || !url.startsWith('https://')) return
    shell.openExternal(url)
})
ipcMain.handle('dark-mode:system', () => {
    nativeTheme.themeSource = 'system'
})
ipcMain.handle('dark-mode:light', () => {
    nativeTheme.themeSource = 'light'
})
ipcMain.handle('dark-mode:dark', () => {
    nativeTheme.themeSource = 'dark'
})

ipcMain.on('ondragstart', (event, filePath) => {
    event.sender.startDrag({
        file: filePath,
        icon: path.join(__dirname, 'renderer/assets/icon/16/drag.png')
    })
})
ipcMain.on('get-text', (event, key) => {
    event.returnValue = i18n.getText(key);
});
ipcMain.on('get-language', (event) => {
    event.returnValue = i18n.getLanguage();
});


// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can onlybe used after this event occurs.
app.on('ready', () => {
    i18n.init();
    createMainWindow();
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
    killProcess()
    app.quit();
})

app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
    }
})