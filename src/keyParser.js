// 解析 nfc-mfdetect / mfoc 的密钥检测输出。工具分两个阶段报密钥:
// 1) 内置密钥阶段: "Sector 07 - Found   Key A: <hex> Found   Key B: <hex>"
// 2) 距离攻击恢复阶段: 扇区头与密钥是两条物理行 ——
//    "Sector: 7, type A, probe 3, distance 12456 ......"   (source/mfoc/src/mfoc.c:555 + 568 的点)
//    "  Found Key: A [112233445566]"                        (同文件 602, 在 571 的换行之后)
//    所以扇区上下文必须跨行保持, 两个阶段也各自维护状态。
// 扇区号一律取工具自己打印的值, 不用匹配序号反推 —— stdout 分块边界与扇区边界无关。
function createKeyInfoParser() {
    const sectorRe = /Sector\s+(\d+)\s*-\s*(?:Found|Unknown)\s+Key\s+[AB]/
    const recoverSectorRe = /Sector:\s*(\d+),\s*type\s*[AB]/
    const recoverKeyRe = /Found\s+Key:\s*([AB])\s*\[([0-9a-fA-F]{12})\]/g
    let keyRe = null
    let buffer = ""
    let sector = null
    let recoverSector = null

    return {
        // 喂入任意切分的 stdout 片段, 返回本次新增的记录
        push(chunk) {
            const records = []
            buffer += chunk
            const lines = buffer.split("\n")
            buffer = lines.pop()
            if (!keyRe) keyRe = /(Found|Unknown)\s+Key\s+([AB]):?\s*([0-9a-fA-F]{12})?/g
            for (const line of lines) {
                const head = sectorRe.exec(line)
                if (head) sector = parseInt(head[1], 10)
                if (sector !== null) {
                    keyRe.lastIndex = 0
                    let m
                    while ((m = keyRe.exec(line)) !== null) {
                        if (m[1] === "Found") {
                            if (!m[3]) continue
                            records.push({key: m[3].toLowerCase(), sector, type: m[2], recovered: false})
                        } else {
                            records.push({key: null, sector, type: m[2], recovered: false})
                        }
                    }
                }
                const recoverHead = recoverSectorRe.exec(line)
                if (recoverHead) recoverSector = parseInt(recoverHead[1], 10)
                if (recoverSector !== null && recoverKeyRe.test(line)) {
                    recoverKeyRe.lastIndex = 0
                    let r
                    while ((r = recoverKeyRe.exec(line)) !== null) {
                        records.push({key: r[2].toLowerCase(), sector: recoverSector, type: r[1], recovered: true})
                    }
                }
            }
            return records
        }
    }
}

// 通用按行缓冲: stdout 一次喂进来的字节数与行边界无关, 跨块的行必须先拼完整再解析。
// 与 Tauri 侧 task.rs 的 BufReader::lines() 行为对齐。
function createLineSplitter() {
    let buffer = ""
    return (chunk) => {
        buffer += chunk
        const lines = buffer.split("\n")
        buffer = lines.pop()
        return lines
    }
}

module.exports = {createKeyInfoParser, createLineSplitter}