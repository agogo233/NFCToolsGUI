// 日志进度行处理。工具用 \r\33[2K (VT100_cleareol) 原地刷新进度, 见 source/*/VT100_cleareol;
// 渲染层模拟终端: 每遇到一个标记就擦掉当前行再写入新内容。
// 一个块里可能连带多个标记 —— Tauri 端 task.rs 按行缓冲, 工具输出的无换行进度
// (libnfc-collect / nfc-mfdict) 会攒成一行才发出, 因此必须逐个标记处理。

function eraseLastLine(log) {
    // 以换行结尾时当前行是空行, 擦除无副作用; 否则删除末尾未换行的一行 (含内容)
    if (log.endsWith("\n")) return log
    const lastBreak = log.lastIndexOf("\n")
    return lastBreak < 0 ? "" : log.substring(0, lastBreak + 1)
}

function appendLogChunk(log, value) {
    const parts = value.split(/\r?\x1b\[2K/)
    for (let i = 0; i < parts.length; i++) {
        if (i > 0) log = eraseLastLine(log)
        log += parts[i]
    }
    return log
}

// 浏览器里是全局函数; Node 里 (test/parse) 可 require
if (typeof module !== "undefined" && module.exports) {
    module.exports = {eraseLastLine, appendLogChunk}
}
