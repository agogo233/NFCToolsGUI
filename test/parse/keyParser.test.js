// 密钥输出解析的回归测试: node test/parse/keyParser.test.js
// 重点验证"分块不变性" —— stdout 一次喂进来的字节数与扇区边界无关。
const {createKeyInfoParser, createLineSplitter} = require("../../src/keyParser")

let failed = 0
function check(name, cond, extra) {
    if (cond) {
        console.log(`  ok   ${name}`)
    } else {
        failed++
        console.log(`  FAIL ${name}${extra === undefined ? "" : ` -> ${extra}`}`)
    }
}
function eq(name, actual, expected) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    check(name, a === e, a === e ? "" : `got ${a}, want ${e}`)
}

// nfc-mfdetect 的真实输出格式 (见 source/nfc-mfdetect/src/nfc-mfdetect.c:451-468):
// 每个扇区一行, A/B 两条密钥信息同属该行, B 行的前导空格来自 A 行结尾的空格。
function mfdetectOutput(sectors, foundEvery) {
    const step = foundEvery || 3
    let out = ""
    for (let i = 0; i < sectors; i++) {
        const tag = String(i).padStart(2, "0")
        if (i % step === 0) {
            out += `Sector ${tag} - Found   Key A: ffffffffffff Found   Key B: a0a1a2a3a4a5\n`
        } else {
            out += `Sector ${tag} - Unknown Key A               Unknown Key B\n`
        }
    }
    return out
}

function parseChunks(chunks) {
    const parser = createKeyInfoParser()
    const known = []
    const unknown = []
    const newKeys = []
    for (const chunk of chunks) {
        for (const r of parser.push(chunk)) {
            if (r.key !== null) {
                known.push([r.key, r.sector, r.type])
                newKeys.push(r.key)
            } else {
                unknown.push([r.sector, r.type])
            }
        }
    }
    return {known, unknown, newKeys}
}
function split(text, size) {
    const out = []
    for (let o = 0; o < text.length; o += size) out.push(text.slice(o, o + size))
    return out
}

console.log("[parse] 1. 整块输入下的解析正确性")
{
    const out = mfdetectOutput(16, 3)
    const r = parseChunks([out])
    eq("1K 卡: 已知密钥条目数", r.known.length, 12)
    eq("1K 卡: 未知密钥条目数", r.unknown.length, 20)
    eq("首个已知密钥", r.known[0], ["ffffffffffff", 0, "A"])
    eq("首个已知密钥的 B 位", r.known[1], ["a0a1a2a3a4a5", 0, "B"])
    eq("首个未知密钥", r.unknown[0], [1, "A"])
    eq("第二个未知密钥", r.unknown[1], [1, "B"])
    check("新密钥被收集", r.newKeys.length === 12, r.newKeys.length)
}

console.log("[parse] 2. 扇区号取自工具输出, 不是匹配序号")
{
    const out = mfdetectOutput(8, 3)
    const r = parseChunks([out])
    eq("扇区 0 有 A/B 两条", r.known.slice(0, 2).map((k) => k[1]), [0, 0])
    eq("扇区 3 有 A/B 两条", r.known.slice(2, 4).map((k) => k[1]), [3, 3])
    eq("扇区 1 有两条未知", r.unknown.slice(0, 2).map((u) => u[0]), [1, 1])
    eq("扇区 2 有两条未知", r.unknown.slice(2, 4).map((u) => u[0]), [2, 2])
}

console.log("[parse] 3. 分块不变性 (核心回归点)")
{
    const out = mfdetectOutput(64, 3)
    const base = parseChunks([out])
    eq("4K 卡: 已知密钥条目数", base.known.length, 44)
    eq("4K 卡: 未知密钥条目数", base.unknown.length, 84)
    for (const size of [1, 7, 64, 100, 512, 1000, 2048, 3000, 4096]) {
        const r = parseChunks(split(out, size))
        eq(`分块 ${size}B: 已知序列与整块一致`, r.known, base.known)
        eq(`分块 ${size}B: 未知序列与整块一致`, r.unknown, base.unknown)
    }
}

console.log("[parse] 4. 边界与噪声输入")
{
    const parser = createKeyInfoParser()
    eq("空输入", parser.push(""), [])
    eq("只有换行", parser.push("\n"), [])
    eq("无 Sector 头的密钥行被忽略", parser.push("Found   Key A: ffffffffffff\n"), [])
    eq("扇区号大于 9 (不依赖两位补零)", parser.push("Sector 12 - Unknown Key A\n"), [{key: null, sector: 12, type: "A"}])
    eq("11 位 hex 不算完整密钥", parser.push("Sector 00 - Found   Key A: fffffffffff\n"), [])
    eq("非 Mifare Classic 的杂项输出不影响扇区", parser.push("Found Mifare Classic Mini tag\n"), [])
    const p2 = createKeyInfoParser()
    eq("分块喂入后仍能接上被切断的密钥行", p2.push("Sector 00 - Found   Key A: ffffff"), [])
    eq("续行补全后产出该密钥", p2.push("ffffff Found   Key B: a0a1a2a3a4a5\n"), [
        {key: "ffffffffffff", sector: 0, type: "A"},
        {key: "a0a1a2a3a4a5", sector: 0, type: "B"}
    ])
}

console.log("[parse] 5. 大写 hex 归一化为小写 (与 keys.txt 保持一致)")
{
    const parser = createKeyInfoParser()
    const r = parser.push("Sector 00 - Found   Key A: FFFFFFFFFFFF\n")
    eq("大写输入归一化", r, [{key: "ffffffffffff", sector: 0, type: "A"}])
}

// 旧实现的对照: 用匹配序号 i/2 反推扇区号, 且不做跨块行缓冲。
// 保留这段是为了说明第 3 组测试在保护什么 —— 序号是"当前分块内"的下标,
// 与扇区边界无关, 一旦 stdout 跨块, 扇区号会整体错位并静默丢密钥。
console.log("[parse] 6. 旧实现对照 (预期: 分块后与整块不一致)")
{
    const oldRe = / (\w{5}|\w{7})\s+Key \w(: \w{12}|)/g
    function oldParse(text, size) {
        const known = []
        const unknown = []
        for (const chunk of split(text, size)) {
            const m = chunk.match(oldRe)
            if (!m) continue
            m.forEach((s, i) => {
                const sector = parseInt(`${i / 2}`)
                if (s[1] === "F") known.push([s.substring(16, 28), sector, s[13]])
                else if (s[1] === "U") unknown.push([sector, s[13]])
            })
        }
        return {known, unknown}
    }
    const out = mfdetectOutput(64, 3)
    const whole = oldParse(out, out.length)
    for (const size of [512, 2048]) {
        const r = oldParse(out, size)
        const sameCount = r.unknown.length === whole.unknown.length
        const sameSectors = JSON.stringify(r.unknown) === JSON.stringify(whole.unknown)
        check(`旧实现 分块 ${size}B: 确实会丢条目 (证明第 3 组测试有效)`, !sameCount,
            `条目数 ${r.unknown.length} vs 整块 ${whole.unknown.length}`)
        check(`旧实现 分块 ${size}B: 确实会错位扇区号`, !sameSectors)
    }
    // 反向断言: 新实现必须通过同样的比较, 否则第 3 组测试形同虚设
    const fresh = parseChunks(split(out, 2048))
    const base = parseChunks([out])
    check("新实现 分块 2048B: 未知序列与整块一致",
        JSON.stringify(fresh.unknown) === JSON.stringify(base.unknown))
    check("新实现 分块 2048B: 已知序列与整块一致",
        JSON.stringify(fresh.known) === JSON.stringify(base.known))
}

console.log("[parse] 6. 通用按行缓冲器的分块不变性")
{
    // libnfc-collect 的真实输出 (source/libnfc-collect/libnfc-collect.c:709),
    // 三个待检测子串都在这一条里, 跨块切开会全部取不到
    const collectOutput =
        "Found tag with uid 1a2b, collecting nonces for key B of block 15 (sector 3) using known key A ffffffffffff for block 0 (sector 0)\n" +
        "Found tag with uid 1a2b, collecting nonces for key A of block 7 (sector 1) using known key A ffffffffffff for block 0 (sector 0)\n"
    const base = (() => {
        const next = createLineSplitter()
        const out = []
        for (const line of next(collectOutput)) out.push(line)
        return out
    })()
    eq("整块输入: 得到 2 行", base.length, 2)
    for (const size of [1, 7, 64, 150, 151, 152, 512]) {
        const next = createLineSplitter()
        const out = []
        for (const chunk of split(collectOutput, size)) out.push(...next(chunk))
        eq(`分块 ${size}B: 行序列与整块一致`, out, base)
    }
    const next = createLineSplitter()
    eq("末尾无换行的半行不产出", next("abc"), [])
    eq("补上换行后产出该行", next("def\n"), ["abcdef"])
}

console.log(failed === 0 ? "[parse] PASSED" : `[parse] FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
