// UI 布局回归测试主进程：以真实 preload + stub IPC + 示例数据打开每页,
// 收集几何指标并做结构断言(硬失败)与软断言(仅告警)
const {app, BrowserWindow, ipcMain} = require("electron")
const path = require("path")
const fs = require("fs")

const ROOT = path.join(__dirname, "..", "..")
const LANG = process.env.UI_LANG || "zh-CN"
const TOL = parseFloat(process.env.UI_TOL || "4")
const STRICT_FRAME = process.env.UI_STRICT_FRAME === "1"

const texts = JSON.parse(fs.readFileSync(path.join(ROOT, "src/locales", `${LANG}.json`), "utf8"))

// 示例数据(固定内容, 保证断言可复现)
const sector = (lines) => lines.join("\n")
const editorSectors = [
    sector(["0000000000000000000000000000FFFF", "4807E000000000000000000000000000", "A0000000000000000000000000000000", "FF078000000000000000000000000000"]),
    sector(["01020304050607080910111213141516", "1718191A1B1C1D1E1F20212223242526", "2728292A2B2C2D2E2F30313233343536", "3738393A3B3C3D3E3F40414243444546"]),
    sector(["AABBCCDDEEFF00112233445566778899", "99887766554433221100FFEEDDCCBBAA", "00001111222233334444555566667777", "77776666555544443333222211110000"]),
    sector(["12345678ABCDEF0123456789ABCDEF01", "23456789ABCDEF0123456789ABCDEF0123", "00000000000000000000000000000000", "11112222333344445555666677778888"]),
    sector(["DEADBEEFCAFEBABEDEADBEEFCAFEBABE", "FEEDFACEF00DFACEDEADBEEFCAFEBABE", "3333444455556666777788889999AAAA", "BBBCCCDD111122223333444455556666"]),
    sector(["0F0E0D0C0B0A09080706050403020100", "000102030405060708090A0B0C0D0E0F", "FEDCBA9876543210FEDCBA9876543210", "0102030405060708090A0B0C0D0E0F10"]),
]
const cmpSector = (base) => [
    "0000000000000000000000000000FFFF",
    "4807E000000000000000000000000000",
    "A0" + base.toString(16).toUpperCase().padStart(2, "0").slice(0, 2) + "000000000000000000000000",
    "FF078000000000000000000000000000",
]
const cmpA = [1, 2, 3, 4, 5, 6].map(cmpSector)
const cmpB = [1, 9, 3, 4, 5, 7].map(cmpSector)
const historyNames = ["dump_20260901_m1.bin", "dump_20260915_uxda.bin", "dump_20260928_ev1.bin"]
const logLines = "[09:14:02] scan devices: found 2 readers\n[09:14:03] connect GSWX-0001 OK\n[09:14:05] read IC: Key found AAAAAAAA"

// stub IPC: 覆盖 preload.js 暴露的全部通道
ipcMain.on("get-text", (event, key) => {event.returnValue = texts[key] || key})
ipcMain.on("get-language", (event) => {event.returnValue = LANG})
ipcMain.on("rendered", () => {})
ipcMain.on("ondragstart", () => {})
ipcMain.handle("exec-action", () => null)
ipcMain.handle("get-app-version", () => "0.0.0-ui-test")
ipcMain.handle("get-builder", () => "ui-test")
ipcMain.handle("close-current-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.close()
})
ipcMain.handle("minimize-current-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.minimize()
})
ipcMain.handle("open-link", () => null)
ipcMain.handle("dark-mode:light", () => null)
ipcMain.handle("dark-mode:dark", () => null)
ipcMain.handle("dark-mode:system", () => null)

const injectIndex = (wc) => {
    wc.send("update-status", {text: texts["indicator_free"], indicator: "free"})
    wc.send("update-usb-devices", ["/dev/tty.usbmodemGSW1", "/dev/tty.usbmodemGSW2"])
    wc.send("update-device-status", {state: "connected", device: "GSWX-0001"})
    wc.send("update-events", {type: "key", text: "sample: 2 keys saved"})
    wc.send("update-log-output", logLines)
}
const injectHardNested = (wc) => {
    wc.send("update-hard-nested-config", {knownKey: "ffffffffffff", knownSector: "0", knownKeyType: "A", targetSector: "3", targetKeyType: "B"})
}
const injectDictTest = (wc) => {
    wc.send("update-dict-test-config", {targetSector: "1", targetKeyType: "B"})
}
const injectDumpEditor = (wc) => {
    wc.send("binary-data", {url: "/dumps/demo_mifare1.bin", data: editorSectors})
}
const injectDumpComparator = (wc) => {
    wc.send("binary-data", {url: "/dumps/A.bin", data: cmpA, type: "A"})
    setTimeout(() => {
        wc.send("binary-data", {url: "/dumps/B.bin", data: cmpB, type: "B"})
    }, 250)
}
const injectDumpHistory = (wc) => {
    wc.send("update-dump-history", historyNames)
}

// 各页尺寸: 与 src/windows.js 一致, tag 区分 win32 小尺寸组与其他平台组
const PAGES = [
    {
        name: "index", file: "index.html", sizes: [[800, 700, "std"]],
        inject: injectIndex,
        rects: ["#title-bar", "#device-status-bar", ".main-button-area", ".bottom-area", "#log", "#left-bar .bar-button"],
        soft: [
            ["#log", "w", 694],
            [".bottom-area", "h", 400],
        ],
        checks(ctx) {
            const m = ctx.m
            const out = []
            const pair = (aSel, bSel, label) => {
                const a = m.rects[aSel]
                const b = m.rects[bSel]
                if (!a || !b) return
                out.push({name: `no-overlap:${label}`, ok: a.bottom <= b.top + 1, detail: `${aSel}.bottom ${a.bottom} vs ${bSel}.top ${b.top}`, hard: true})
            }
            pair("#title-bar", "#device-status-bar", "title-bar/device-status")
            pair("#device-status-bar", ".main-button-area", "device-status/main-button")
            pair(".main-button-area", ".bottom-area", "main-button/bottom-area")
            const btn = m.rects["#left-bar .bar-button"]
            if (btn) out.push({name: "left-bar-button-visible", ok: btn.top >= 0 && btn.bottom <= m.clientH, detail: `first left-bar button top ${btn.top} bottom ${btn.bottom}`, hard: true})
            return out
        },
    },
    {
        name: "settings", file: "settings.html", sizes: [[400, 510, "std"], [400, 470, "win32"]],
        framePessimistic: "win32-only",
        rects: [".final-button button"],
        css: [{sel: ".final-button button", props: ["height", "margin-right", "margin-top"]}],
        cssSoft: [
            [".final-button button", "height", "30px"],
            [".final-button button", "margin-right", "15px"],
            [".final-button button", "margin-top", "20px"],
        ],
    },
    {
        name: "inputkeys", file: "inputkeys.html", sizes: [[400, 200, "std"], [400, 160, "win32"]],
        framePessimistic: "win32-only",
        rects: ["input[type='text']"],
        css: [{sel: "input[type='text']", props: ["margin-top"]}],
        cssSoft: [
            ["input[type='text']", "margin-top", "20px"],
        ],
    },
    {
        name: "hardNested", file: "hardNested.html", sizes: [[500, 610, "std"], [500, 570, "win32"]],
        inject: injectHardNested,
        framePessimistic: "win32-only",
        rects: [".final-button button", "input[type='text']"],
        lists: [".radio-group"],
        css: [
            {sel: ".radio-group", props: ["white-space", "width"]},
            {sel: ".sub-title", props: ["margin-bottom"]},
            {sel: ".final-button button", props: ["height", "margin-right", "margin-top"]},
            {sel: "input[type='text']", props: ["margin-top"]},
        ],
        cssSoft: [
            [".radio-group", "white-space", "nowrap"],
            [".radio-group", "width", "200px"],
            [".sub-title", "margin-bottom", "10px"],
            [".final-button button", "height", "30px"],
            [".final-button button", "margin-right", "15px"],
            [".final-button button", "margin-top", "20px"],
            ["input[type='text']", "margin-top", "20px"],
        ],
    },
    {
        name: "dictTest", file: "dictTest.html", sizes: [[450, 390, "std"], [450, 350, "win32"]],
        inject: injectDictTest,
        framePessimistic: "win32-only",
        rects: [".final-button button", "input[type='text']"],
        lists: [".radio-group"],
        css: [
            {sel: ".radio-group", props: ["white-space", "width"]},
            {sel: "#dict-file", props: ["width"]},
            {sel: ".final-button button", props: ["height", "margin-right"]},
        ],
        cssSoft: [
            [".radio-group", "white-space", "nowrap"],
            [".radio-group", "width", "200px"],
            ["#dict-file", "width", "200px"],
            [".final-button button", "height", "30px"],
            [".final-button button", "margin-right", "15px"],
        ],
    },
    {
        name: "dumpEditor", file: "dumpEditor.html", sizes: [[380, 720, "std"]],
        inject: injectDumpEditor,
        scrollable: true,
        css: [{sel: "#update-tag-color", props: ["margin-top", "margin-right", "margin-bottom", "margin-left"]}],
        cssSoft: [
            ["#update-tag-color", "margin-top", "0px"],
            ["#update-tag-color", "margin-right", "10px"],
            ["#update-tag-color", "margin-bottom", "0px"],
            ["#update-tag-color", "margin-left", "15px"],
        ],
    },
    {
        name: "dumpComparator", file: "dumpComparator.html", sizes: [[380, 720, "std"]],
        inject: injectDumpComparator, stagger: 900,
        scrollable: true,
        rects: ["#top-bar", "#top-bar button", "#compare-container"],
        css: [
            {sel: "#top-bar button", props: ["height"]},
            {sel: "#compare-container", props: ["margin-top"]},
        ],
        cssSoft: [
            ["#top-bar button", "height", "20px"],
            ["#compare-container", "margin-top", "80px"],
        ],
        soft: [
            ["#top-bar button", "h", 20],
            ["#compare-container", "top", 80],
        ],
        checks(ctx) {
            const m = ctx.m
            const tb = m.rects["#top-bar"]
            const cc = m.rects["#compare-container"]
            if (tb && cc) {
                return [{name: "no-overlap:top-bar/compare", ok: tb.bottom <= cc.top + 1, detail: `#top-bar.bottom ${tb.bottom} vs #compare-container.top ${cc.top}`, hard: true}]
            }
            return []
        },
    },
    {
        name: "dumpHistory", file: "dumpHistory.html", sizes: [[380, 720, "std"]],
        inject: injectDumpHistory,
        scrollable: true,
        rects: ["#buttons"],
        css: [
            {sel: "body", props: ["margin-bottom"]},
            {sel: "#buttons", props: ["padding-top", "padding-bottom"]},
            {sel: "#buttons button", props: ["height", "margin-top", "margin-right", "margin-bottom", "margin-left"]},
        ],
        cssSoft: [
            ["#buttons", "padding-top", "10px"],
            ["#buttons", "padding-bottom", "20px"],
            ["#buttons button", "height", "30px"],
            ["#buttons button", "margin-top", "10px"],
            ["#buttons button", "margin-right", "10px"],
            ["#buttons button", "margin-bottom", "20px"],
            ["#buttons button", "margin-left", "15px"],
        ],
        checks(ctx) {
            const m = ctx.m
            const btns = m.rects["#buttons"]
            const bodyMb = m.css["body"] && m.css["body"]["margin-bottom"]
            if (btns && bodyMb) {
                // 固定页脚高于 body 预留区时会盖住列表尾部, 仅告警
                const mb = parseInt(bodyMb, 10)
                return [{name: "footer-coverage", ok: btns.h <= mb, detail: `#buttons h ${btns.h} vs body margin-bottom ${mb}px`, hard: false}]
            }
            return []
        },
    },
    {
        name: "about", file: "about.html", sizes: [[600, 480, "std"]],
    },
]

// 页面内几何采集: payload 直接内嵌进代码字符串
// (Electron 44 沙箱渲染进程下 executeJavaScript(code, args) 的参数通道会抛 clone 错误)
const collectCode = (page) => `((payload) => {
    const rects = payload.rects, lists = payload.lists, css = payload.css
    const root = document.documentElement
    const round = (n) => Math.round(n * 100) / 100
    const rectOf = (el) => {
        if (!el) return null
        const b = el.getBoundingClientRect()
        return {top: round(b.top), bottom: round(b.bottom), left: round(b.left), right: round(b.right), w: round(b.width), h: round(b.height)}
    }
    const out = {rects: {}, lists: {}, css: {}}
    for (const sel of rects) out.rects[sel] = rectOf(document.querySelector(sel))
    for (const sel of lists) out.lists[sel] = Array.from(document.querySelectorAll(sel)).map(rectOf)
    let contentBottom = 0
    for (const el of document.querySelectorAll("body *")) {
        const b = el.getBoundingClientRect()
        if (b.bottom > contentBottom) contentBottom = b.bottom
    }
    for (const item of css) {
        const el = document.querySelector(item.sel)
        out.css[item.sel] = el ? (() => {
            const cs = getComputedStyle(el)
            const r = {}
            for (const p of item.props) r[p] = cs[p]
            return r
        })() : null
    }
    return {
        scrollH: root.scrollHeight, clientH: root.clientHeight, scrollW: root.scrollWidth, clientW: root.clientWidth,
        placeholder: document.body.innerText.includes("{{") || document.title.includes("{{"),
        contentBottom: round(contentBottom),
        rects: out.rects, lists: out.lists, css: out.css,
    }
})(${JSON.stringify({rects: page.rects || [], lists: page.lists || [], css: page.css || []})})`

const commonChecks = (page, m, ctx) => {
    const out = []
    // 数据页(dump 系列)内容按设计可滚动, 文档级不溢出仅对固定布局页硬失败
    // 固定页允许 +TOL 的跨环境字体度量漂移(真实回归以 10px+ 计)
    out.push({name: "overflow-v", ok: m.scrollH <= m.clientH + TOL, detail: `scrollH ${m.scrollH} vs clientH ${m.clientH} (tol +${TOL})`, hard: !page.scrollable})
    out.push({name: "overflow-h", ok: m.scrollW <= m.clientW + TOL, detail: `scrollW ${m.scrollW} vs clientW ${m.clientW} (tol +${TOL})`, hard: !page.scrollable})
    out.push({name: "no-placeholder", ok: !m.placeholder, detail: m.placeholder ? "found literal {{ }} residue" : "no {{ }} residue", hard: true})
    for (const sel of page.lists || []) {
        for (const r of m.lists[sel] || []) {
            if (r.h > 34) out.push({name: `no-wrap:${sel}`, ok: false, detail: `${sel} height ${r.h} (wrapped)`, hard: true})
        }
    }
    // 悲观帧边界: 真实 Windows 边框吃掉约 32px, 默认仅告警, UI_STRICT_FRAME=1 时硬失败
    if (page.framePessimistic === "win32-only" && ctx.tag === "win32") {
        const limit = ctx.winH - 32
        out.push({name: "frame-pessimistic", ok: m.contentBottom <= limit, detail: `contentBottom ${m.contentBottom} vs winH-32 ${limit} (win32 frame pessimistic)`, hard: STRICT_FRAME})
    }
    return out
}

const softChecks = (def, m) => {
    const out = []
    for (const [sel, prop, expect] of def || []) {
        const r = m.rects[sel]
        if (!r || r[prop] == null) continue
        const ok = Math.abs(r[prop] - expect) <= TOL
        out.push({name: `soft:${sel}.${prop}`, ok, detail: `measured ${r[prop]} expect ${expect}±${TOL}`, hard: false})
    }
    return out
}

const cssChecks = (def, m) => {
    const out = []
    for (const [sel, prop, expect] of def || []) {
        const c = m.css[sel]
        if (!c || c[prop] == null) continue
        const ok = c[prop] === expect
        out.push({name: `css:${sel} ${prop}`, ok, detail: `computed ${c[prop]} expect ${expect}`, hard: false})
    }
    return out
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const raceTimeout = (promise, ms, label) => {
    return Promise.race([promise, delay(ms).then(() => {
        throw new Error(`${label} timeout after ${ms}ms`)
    })])
}

async function runPage(page, w, h, tag) {
    const label = `${page.name}@${w}x${h}[${tag}]`
    const win = new BrowserWindow({
        width: w, height: h, frame: false, show: false, resizable: false,
        webPreferences: {preload: path.join(ROOT, "src/preload.js")},
    })
    const consoleIssues = []
    win.webContents.on("console-message", (msg) => {
        if (msg.level >= 3) consoleIssues.push(`${label} ${msg.message}`)
    })
    try {
        await raceTimeout(win.loadFile(path.join(ROOT, "src/renderer/html", page.file)), 15000, label)
        await delay(300)
        if (page.inject) page.inject(win.webContents)
        await delay(page.stagger || 600)
        const m = await raceTimeout(win.webContents.executeJavaScript(collectCode(page)), 10000, label)
        const ctx = {winH: h, tag, page, m}
        const results = []
        // 声明过的选择器必须真实存在, 防止回归删除元素后检查被静默跳过
        for (const sel of page.rects || []) {
            results.push({name: `present:${sel}`, ok: m.rects[sel] != null, detail: m.rects[sel] != null ? "found" : "selector not found", hard: true})
        }
        for (const sel of page.lists || []) {
            results.push({name: `present:${sel}`, ok: Array.isArray(m.lists[sel]), detail: Array.isArray(m.lists[sel]) ? `count ${m.lists[sel].length}` : "selector not found", hard: true})
        }
        results.push(...commonChecks(page, m, ctx))
        if (page.checks) results.push(...page.checks(ctx))
        results.push(...softChecks(page.soft, m))
        results.push(...cssChecks(page.cssSoft, m))
        return {label, results, consoleIssues}
    } catch (err) {
        console.error(`[ui-test] ${label} fatal: ${err.message}`)
        throw err
    } finally {
        if (!win.isDestroyed()) win.close()
    }
}

function report(reportList) {
    let hardFail = 0
    let softFail = 0
    const warnings = []
    for (const {label, results, consoleIssues} of reportList) {
        console.log(`[ui-test] ${label}`)
        let pageHard = 0
        let pageSoft = 0
        for (const r of results) {
            if (!r.ok) {
                if (r.hard) pageHard += 1
                else pageSoft += 1
            }
            console.log(`  ${r.ok ? "PASS" : (r.hard ? "FAIL" : "WARN")} ${r.name}: ${r.detail}`)
        }
        for (const issue of consoleIssues) warnings.push(issue)
        hardFail += pageHard
        softFail += pageSoft
        console.log(`  -> hard ${pageHard} / soft ${pageSoft}`)
    }
    if (warnings.length > 0) {
        console.log("[ui-test] console issues (non-fatal, error level only):")
        for (const w of warnings) console.log(`  ${w}`)
    }
    console.log(`[ui-test] summary: hard fails ${hardFail}, soft/warn ${softFail}`)
    return hardFail === 0
}

app.disableHardwareAcceleration()
app.commandLine.appendSwitch("disable-gpu")

const allReports = []
app.whenReady().then(async () => {
    let ok = false
    try {
        for (const page of PAGES) {
            for (const [w, h, tag] of page.sizes) {
                allReports.push(await runPage(page, w, h, tag))
            }
        }
        ok = report(allReports)
    } catch (err) {
        console.error("[ui-test] matrix aborted:", err && err.message)
    }
    app.quit()
    process.exit(ok ? 0 : 1)
}).catch((err) => {
    console.error("[ui-test] app ready failed:", err && err.message)
    process.exit(1)
})

// 全局墙钟保护, 防止挂死耗尽 CI 分钟
setTimeout(() => {
    console.error("[ui-test] global timeout (180s), aborting")
    process.exit(1)
}, 180000)
