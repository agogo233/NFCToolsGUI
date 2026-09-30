// 解析 nfc-mfdetect / mfoc 的密钥检测输出。
// 工具每行输出 "Sector NN - Found   Key A: <hex> Found   Key B: <hex>",
// A/B 两行同属一个 Sector, 因此这里直接捕获工具已打印的扇区号, 不再用匹配序号反推 ——
// stdout 的分块边界与扇区边界无关, 用序号反推会在跨块时整体错位。
function createKeyInfoParser() {
    const sectorRe = /Sector\s+(\d+)\s*-\s*(?:Found|Unknown)\s+Key\s+[AB]/
    let keyRe = null
    let buffer = ""
    let sector = null

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
                if (sector === null) continue
                keyRe.lastIndex = 0
                let m
                while ((m = keyRe.exec(line)) !== null) {
                    if (m[1] === "Found") {
                        if (!m[3]) continue
                        records.push({key: m[3].toLowerCase(), sector, type: m[2]})
                    } else {
                        records.push({key: null, sector, type: m[2]})
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