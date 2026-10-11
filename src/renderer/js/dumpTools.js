// 卡数据体检与修复。纯函数, 不碰 DOM 与 IPC —— Electron 与 Tauri 两个端口共用这一份,
// 也被 test/parse/dumpTools.test.js 直接 require。
//
// 访问控制位的位序必须原样照搬 MifareOneTool 的 Utils.ReadAC / ReadRAC
// (MifareOneTool/ClassMifareS50.cs:41-79), 它与 NXP 数据手册的排布不同, 且 ReadRAC
// 内部用加法累加、会进位, 不能简化成"高低半字节互反"的位约束。自己推会得到不同结论。
// 这套位序与自家 nfc-mfclassic 写出的默认访问位一致
// (source/libnfc/utils/nfc-mfclassic.c:94 default_acl = {0xff,0x07,0x80,0x69}),
// 即"修完的卡"与"格式化出来的卡"访问位相同。

const BLOCK_SIZE = 16
// nfc-mfclassic 认可的卡容量 (source/libnfc/utils/nfc-mfclassic.c:748-769)
const VALID_SIZES = [1024, 2048, 4096]
// 修复访问位时写回的目标值。b6..b8 取自家格式化的默认值; b9 是用户字节,
// 不参与访问位判定 (已验证: 改 b9 不影响校验结果), 保留原值 —— 体检是修复, 不是格式化。
const FIX_ACCESS_BYTES = [0xff, 0x07, 0x80]

// 扇区尾块(密钥/访问控制所在块)在小卡与大卡上的间隔不同
// 见 source/libnfc/utils/nfc-mfclassic.c:158-176
function sectorFirstBlock(sector, blockCount) {
    if (blockCount <= 128) return sector * 4
    return sector < 32 ? sector * 4 : 128 + (sector - 32) * 16
}

// 扇区序号 -> 编辑器里的分组下标。编辑器固定按每 4 行分一组, 与实际扇区大小无关,
// 所以大卡上两者并不一一对应 (4K 卡的 32 号以后每扇区 16 块, 分组下标要靠这个换算)。
function sectorGroupIndex(sector, blockSize) {
    return sectorFirstBlock(sector, blockSize / BLOCK_SIZE) / 4
}

function sectorCount(blockCount) {
    if (blockCount <= 128) return blockCount / 4
    return 32 + (blockCount - 128) / 16
}

function readAccessBits(ac) {
    const out = [0, 0, 0, 0]
    out[0] = ((ac[2] & 0x10) >> 4) + ((ac[2] & 0x01) << 1) + ((ac[1] & 0x10) >> 2)
    out[1] = ((ac[2] & 0x20) >> 5) + ((ac[2] & 0x02) * 1) + ((ac[1] & 0x20) >> 3)
    out[2] = ((ac[2] & 0x40) >> 6) + ((ac[2] & 0x04) >> 1) + ((ac[1] & 0x40) >> 4)
    out[3] = ((ac[2] & 0x80) >> 7) + ((ac[2] & 0x08) >> 2) + ((ac[1] & 0x80) >> 5)
    return out
}

function readReversedAccessBits(ac) {
    const inv = ac.map((b) => (~b) & 0xff)
    const out = [0, 0, 0, 0]
    out[0] = ((inv[0] & 0x01) << 2) + ((inv[0] & 0x10) >> 3) + (inv[1] & 0x01)
    out[1] = ((inv[0] & 0x02) << 1) + ((inv[0] & 0x20) >> 4) + ((inv[1] & 0x02) >> 1)
    out[2] = ((inv[0] & 0x04) * 1) + ((inv[0] & 0x40) >> 5) + ((inv[1] & 0x04) >> 2)
    out[3] = ((inv[0] & 0x08) >> 1) + ((inv[0] & 0x80) >> 6) + ((inv[1] & 0x08) >> 3)
    return out
}

// 扇区 0 的块 0: 前 4 字节是 UID, 第 5 字节是它们的异或校验值
function isBccCorrect(bytes, offset) {
    return (bytes[offset] ^ bytes[offset + 1] ^ bytes[offset + 2] ^ bytes[offset + 3] ^ bytes[offset + 4]) === 0
}

// 返回该扇区尾块的访问位问题代码, 正常返回 null
function checkSectorAccess(bytes, offset) {
    const ac = [
        bytes[offset + 6], bytes[offset + 7], bytes[offset + 8], bytes[offset + 9]
    ]
    const forward = readAccessBits(ac)
    const reversed = readReversedAccessBits(ac)
    if (forward.length !== reversed.length) return "acl-corrupt"
    for (let i = 0; i < forward.length; i++) {
        if (forward[i] !== reversed[i]) return "acl-corrupt"
        // ReadAC 的三个移位项至多各贡献一位, 值域恒为 0..7, 该判定实际不会触发。
        // 保留是为了与参考实现逐行对应, 便于日后比对行为。
        if (forward[i] > 0x08) return "acl-invalid"
    }
    return null
}

// 体检一份卡数据。hexData 为小写或大写 hex, 允许含空白。
// 返回 {ok, size, blockSize, errors: [{sector, code, detail}]}
function checkDump(hexData) {
    const bytes = hexToBytes(hexData)
    const errors = []
    if (bytes === null) {
        return {ok: false, size: 0, blockSize: 0, errors: [{sector: null, code: "not-hex", detail: ""}]}
    }
    if (bytes.length % BLOCK_SIZE !== 0) {
        errors.push({sector: null, code: "size", detail: String(bytes.length)})
        return {ok: false, size: bytes.length, blockSize: 0, errors}
    }
    const blockSize = bytes.length
    if (!VALID_SIZES.includes(blockSize)) {
        errors.push({sector: null, code: "size", detail: String(blockSize)})
        return {ok: false, size: blockSize, blockSize, errors}
    }

    const total = sectorCount(blockSize)
    for (let sector = 0; sector < total; sector++) {
        const first = sectorFirstBlock(sector, blockSize) * BLOCK_SIZE
        const trailer = first + 3 * BLOCK_SIZE
        if (trailer + BLOCK_SIZE > bytes.length) break
        // BCC 只对扇区 0 有意义: 其余扇区的块 0 是数据块, 不是 UID 块
        if (sector === 0 && !isBccCorrect(bytes, first)) {
            errors.push({
                sector,
                code: "bcc",
                detail: bytesToHex([bytes[first] ^ bytes[first + 1] ^ bytes[first + 2] ^ bytes[first + 3]])
            })
        }
        const acl = checkSectorAccess(bytes, trailer)
        if (acl) errors.push({sector, code: acl, detail: ""})
    }
    return {ok: errors.length === 0, size: blockSize, blockSize, errors}
}

// 修复: 扇区 0 重算 BCC, 访问位异常的扇区写回默认访问位 (保留用户字节)。
// 返回 {hex, fixed: [{sector, code}]}。无法解析的输入原样返回且 fixed 为空。
function fixDump(hexData) {
    const bytes = hexToBytes(hexData)
    if (bytes === null) return {hex: hexData, fixed: []}
    const blockSize = bytes.length
    if (blockSize % BLOCK_SIZE !== 0 || !VALID_SIZES.includes(blockSize)) {
        return {hex: bytesToHex(bytes), fixed: []}
    }
    const out = Array.from(bytes)
    const fixed = []
    const total = sectorCount(blockSize)
    for (let sector = 0; sector < total; sector++) {
        const first = sectorFirstBlock(sector, blockSize) * BLOCK_SIZE
        const trailer = first + 3 * BLOCK_SIZE
        if (trailer + BLOCK_SIZE > out.length) break
        // 只修扇区 0: 参考实现对全部扇区的块 0 都写 BCC, 那会破坏数据块
        if (sector === 0 && !isBccCorrect(out, first)) {
            out[first + 4] = out[first] ^ out[first + 1] ^ out[first + 2] ^ out[first + 3]
            fixed.push({sector, code: "bcc"})
        }
        const acl = checkSectorAccess(out, trailer)
        if (acl) {
            for (let i = 0; i < FIX_ACCESS_BYTES.length; i++) {
                out[trailer + 6 + i] = FIX_ACCESS_BYTES[i]
            }
            fixed.push({sector, code: acl})
        }
    }
    return {hex: bytesToHex(out), fixed}
}

// 导出密钥字典: 每扇区依次取 KeyA / KeyB, 去重后每行一个 12 位 hex。
// 输出格式与 mfoc -f / nfc-mfdict -d 的密钥文件一致 (源码 mfoc.c:763)。
function dumpToKeyDict(hexData) {
    const bytes = hexToBytes(hexData)
    if (bytes === null) return ""
    // 与 checkDump 用同一套容量口径: 非法容量的卡不该导出密钥, 否则用户会把体检判定为
    // 无效的文件拿去喂 mfoc
    if (!VALID_SIZES.includes(bytes.length)) return ""
    const blockSize = bytes.length
    const keys = []
    const seen = new Set()
    const push = (offset) => {
        let key = ""
        for (let i = 0; i < 6; i++) key += ("0" + bytes[offset + i].toString(16)).slice(-2)
        if (seen.has(key)) return
        seen.add(key)
        keys.push(key)
    }
    const total = sectorCount(blockSize)
    for (let sector = 0; sector < total; sector++) {
        const trailer = sectorFirstBlock(sector, blockSize) * BLOCK_SIZE + 3 * BLOCK_SIZE
        if (trailer + BLOCK_SIZE > bytes.length) break
        push(trailer)
        push(trailer + 10)
    }
    return keys.join("\n")
}

function hexToBytes(hexData) {
    if (typeof hexData !== "string") return null
    const clean = hexData.replace(/\s+/g, "")
    if (clean.length % 2 !== 0) return null
    if (clean.length > 0 && !/^[0-9A-Fa-f]+$/.test(clean)) return null
    const out = new Array(clean.length / 2)
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.substr(i * 2, 2), 16)
    }
    return out
}

function bytesToHex(bytes) {
    let out = ""
    for (let i = 0; i < bytes.length; i++) {
        out += ("0" + bytes[i].toString(16)).slice(-2)
    }
    return out
}

// 浏览器里是全局函数; Node 里 (test/parse) 可 require
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        checkDump, fixDump, dumpToKeyDict, hexToBytes, bytesToHex,
        sectorGroupIndex, sectorFirstBlock, sectorCount,
        BLOCK_SIZE, VALID_SIZES, FIX_ACCESS_BYTES
    }
}
