;(function () {
    function tauri() {
        return window.__TAURI__
    }
    function invoke(command, arg) {
        if (arg === undefined) {
            return tauri().core.invoke(command)
        }
        return tauri().core.invoke(command, arg)
    }
    function listen(channel, callback) {
        tauri().event.listen(channel, function (event) {
            callback(event, event.payload)
        })
    }
    function currentWindow() {
        return tauri().window.getCurrentWindow()
    }
    function setThemeAll(theme) {
        tauri().window.getAllWindows().then(function (windows) {
            windows.forEach(function (win) {
                win.setTheme(theme)
            })
        })
    }
    function showWhenReady(attempt) {
        if (window.__TAURI__) {
            currentWindow().show()
            return
        }
        if (attempt < 100) {
            setTimeout(function () {
                showWhenReady(attempt + 1)
            }, 50)
        }
    }
    var NO_DRAG = "button, input, select, textarea, a, [onclick], .dropdown-menus, .windows-control, .selection"
    function markDragRegions() {
        var bar = document.getElementById("title-bar")
        if (!bar || !bar.setAttribute) return
        function walk(node) {
            var children = Array.prototype.slice.call(node.children)
            for (var i = 0; i < children.length; i++) {
                var child = children[i]
                if (child.matches && child.matches(NO_DRAG)) continue
                child.setAttribute("data-tauri-drag-region", "")
                walk(child)
            }
        }
        bar.setAttribute("data-tauri-drag-region", "")
        walk(bar)
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", markDragRegions)
    } else {
        markDragRegions()
    }
    window.electronAPI = {
        devicePrefix: "/dev/tty.",
        platform: "win32",

        onUpdateLogOutput: (callback) => listen("update-log-output", callback),
        onUpdateStatus: (callback) => listen("update-status", callback),
        onUpdateUSBDevices: (callback) => listen("update-usb-devices", callback),
        onUpdateDeviceStatus: (callback) => listen("update-device-status", callback),
        onUpdateEvents: (callback) => listen("update-events", callback),
        onUpdateProgress: (callback) => listen("update-progress", callback),
        onShowGuidance: (callback) => listen("show-guidance", callback),
        onDumpSaved: (callback) => listen("dump-saved", callback),
        onUpdateDumpEditorFile: (callback) => listen("update-dump-editor-file", callback),
        onUpdateDumpComparatorFile: (callback) => listen("update-dump-comparator-files", callback),
        onSettingNFCConfig: (callback) => listen("setting-nfc-config", callback),
        onSettingsSpeed: (callback) => listen("settings-speed", callback),
        onCreateHardNestedWindow: (callback) => listen("update-hard-nested-config", callback),
        onCreateDictTestWindow: (callback) => listen("update-dict-test-config", callback),
        onCreateDumpHistoryWindow: (callback) => listen("update-dump-history", callback),
        onOpenDictFile: (callback) => listen("dict-file-name", callback),
        onOpenDumpFile: (callback) => listen("binary-data", callback),
        onSavedDumpFile: (callback) => listen("saved-binary-data", callback),

        getVersion: () => invoke("get_app_version"),
        getBuilder: () => invoke("get_builder"),
        closeCurrentWindow: () => currentWindow().close(),
        minimizeCurrentWindow: () => currentWindow().minimize(),
        openLink: (link) => invoke("open_link", { url: link }),
        execAction: (action, arg) => invoke("exec_action", { action, arg }),

        startDrag: () => {},
        rendered: () => showWhenReady(0),
        getText: (key) => (window.__I18N__ && window.__I18N__[key]) || key,
        getLanguage: () => window.__I18N_LANG__ || "en",
    }
    window.darkMode = {
        light: () => setThemeAll("light"),
        dark: () => setThemeAll("dark"),
        system: () => setThemeAll(null),
    }
})()
