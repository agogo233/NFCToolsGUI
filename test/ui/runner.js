// test:ui 入口: Linux 下经 xvfb-run 启动, 每语言各起一个 electron 实例, 汇总退出码
const {spawn, execSync} = require("child_process")
const path = require("path")

const mainPath = path.join(__dirname, "main.js")
const langs = (process.env.UI_LANGS || "zh-CN,en").split(",")

const electronPath = require("electron")

let cmd
let args
if (process.platform === "linux") {
    let hasXvfb = true
    try {
        execSync("command -v xvfb-run", {stdio: "ignore"})
    } catch {
        hasXvfb = false
    }
    if (!hasXvfb) {
        console.error("[ui-test] xvfb-run missing. Install: sudo apt-get install xvfb libgtk-3-0 libnss3 libasound2 libgbm1 fonts-noto-cjk")
        process.exit(1)
    }
    cmd = "xvfb-run"
    args = ["-a", electronPath, mainPath, "--no-sandbox", "--disable-gpu", "--enable-logging"]
} else {
    cmd = electronPath
    args = [mainPath, "--no-sandbox", "--disable-gpu"]
}

let failed = false
let index = 0
function next() {
    if (index >= langs.length) {
        console.log(failed ? "[ui-test] FAILED" : "[ui-test] PASSED")
        process.exit(failed ? 1 : 0)
    }
    const lang = langs[index++]
    console.log(`[ui-test] running lang=${lang}`)
    const child = spawn(cmd, args, {stdio: "inherit", env: {...process.env, UI_LANG: lang}})
    let settled = false
    child.on("error", (err) => {
        if (settled) return
        settled = true
        console.error(`[ui-test] spawn error: ${err.message}`)
        failed = true
        next()
    })
    child.on("exit", (code) => {
        if (settled) return
        settled = true
        if (code !== 0) failed = true
        next()
    })
}
next()
