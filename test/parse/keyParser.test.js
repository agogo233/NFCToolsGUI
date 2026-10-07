// 密钥输出解析的回归测试: node test/parse/keyParser.test.js
// 重点验证"分块不变性" —— stdout 一次喂进来的字节数与扇区边界无关。
const {createKeyInfoParser, createLineSplitter} = require("../../src/keyParser")
const {eraseLastLine, appendLogChunk} = require("../../src/renderer/js/logUtil")

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
    eq("扇区号大于 9 (不依赖两位补零)", parser.push("Sector 12 - Unknown Key A\n"), [{key: null, sector: 12, type: "A", recovered: false}])
    eq("11 位 hex 不算完整密钥", parser.push("Sector 00 - Found   Key A: fffffffffff\n"), [])
    eq("非 Mifare Classic 的杂项输出不影响扇区", parser.push("Found Mifare Classic Mini tag\n"), [])
    const p2 = createKeyInfoParser()
    eq("分块喂入后仍能接上被切断的密钥行", p2.push("Sector 00 - Found   Key A: ffffff"), [])
    eq("续行补全后产出该密钥", p2.push("ffffff Found   Key B: a0a1a2a3a4a5\n"), [
        {key: "ffffffffffff", sector: 0, type: "A", recovered: false},
        {key: "a0a1a2a3a4a5", sector: 0, type: "B", recovered: false}
    ])
}

console.log("[parse] 5. 大写 hex 归一化为小写 (与 keys.txt 保持一致)")
{
    const parser = createKeyInfoParser()
    const r = parser.push("Sector 00 - Found   Key A: FFFFFFFFFFFF\n")
    eq("大写输入归一化", r, [{key: "ffffffffffff", sector: 0, type: "A", recovered: false}])
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

console.log("[parse] 6b. 通用按行缓冲器的分块不变性")
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


console.log("[parse] 7. 距离攻击恢复阶段的密钥格式 (真实输出: 扇区头在上一行)")
{
    // source/mfoc/src/mfoc.c:555 的探测进度行末尾无换行, 568 继续打点, 571 才换行,
    // 602 的 "  Found Key: A [hex]" 在换行之后 —— 扇区上下文在密钥的上一行, 必须跨行保持。
    const p = createKeyInfoParser()
    const out = []
    out.push(...p.push("Sector 06 - Found   Key A: ffffffffffff Found   Key B: a0a1a2a3a4a5\n"))
    out.push(...p.push("Sector 07 - Unknown Key A               Unknown Key B\n"))
    eq("阶段一: 扇区 6 的 A 键", out[0], {key: "ffffffffffff", sector: 6, type: "A", recovered: false})
    eq("阶段一: 扇区 6 的 B 键", out[1], {key: "a0a1a2a3a4a5", sector: 6, type: "B", recovered: false})
    eq("阶段一: 未知密钥 A", out[2], {key: null, sector: 7, type: "A", recovered: false})
    eq("阶段一: 未知密钥 B", out[3], {key: null, sector: 7, type: "B", recovered: false})
    eq("阶段一产出条数", out.length, 4)

    // 探测进度行: 不产出记录, 但要记住扇区上下文
    eq("探测进度行本身不产出记录", p.push("Sector: 7, type A, probe 3, distance 12456 ......\n"), [])
    eq("下一行才产出恢复的密钥 (跨行取上下文)", p.push("  Found Key: A [112233445566]\n"),
        [{key: "112233445566", sector: 7, type: "A", recovered: true}])

    // mfoc.c:496 / nfc-mfdetect.c:500 的快速路径: 扇区行自带换行
    const p2 = createKeyInfoParser()
    eq("快速路径: 扇区行同样不产出记录", p2.push("Sector: 9, type B\n"), [])
    eq("快速路径: 之后一行取出 B 键", p2.push("  Found Key: B [aabbccddeeff]\n"),
        [{key: "aabbccddeeff", sector: 9, type: "B", recovered: true}])

    // 没有任何扇区上下文时不能凭空产出密钥
    const p3 = createKeyInfoParser()
    eq("缺少扇区上下文时不产出", p3.push("  Found Key: A [112233445566]\n"), [])
}

console.log("[parse] 8. 恢复出的密钥要移出待解列表")
{
    // 复刻 keyInfoStatistic 的处理逻辑, 验证 扇区+键位 精确匹配
    const run = (lines) => {
        const parser = createKeyInfoParser()
        const unknown = []
        const known = []
        for (const line of lines) {
            for (const record of parser.push(line)) {
                if (record.key === null) {
                    unknown.push([record.sector, record.type])
                } else {
                    known.push([record.key, record.sector, record.type])
                    if (record.recovered) {
                        const i = unknown.findIndex((u) => u[0] === record.sector && u[1] === record.type)
                        if (i >= 0) unknown.splice(i, 1)
                    }
                }
            }
        }
        return {unknown, known}
    }
    const lines = [
        "Sector 07 - Unknown Key A               Unknown Key B\n",
        "Sector: 7, type A, probe 3, distance 1 ......\n",
        "  Found Key: A [112233445566]\n"
    ]
    let r = run(lines)
    eq("恢复 A 后待解列表只剩 B", r.unknown, [[7, "B"]])
    eq("恢复的密钥进入已知列表", r.known, [["112233445566", 7, "A"]])

    // B 也在另一轮被恢复
    r = run([...lines,
        "Sector: 7, type B, probe 1, distance 2 ......\n",
        "  Found Key: B [aabbccddeeff]\n"])
    eq("A、B 分别恢复后待解列表清空", r.unknown, [])
    eq("两个密钥都在已知列表", r.known.length, 2)

    // 不同扇区的 B 不应被误删
    r = run([
        "Sector 07 - Unknown Key A               Unknown Key B\n",
        "Sector 09 - Unknown Key A               Unknown Key B\n",
        "Sector: 7, type A, probe 1, distance 1 ......\n",
        "  Found Key: A [112233445566]\n"
    ])
    eq("只移除匹配的那一项", r.unknown, [[7, "B"], [9, "A"], [9, "B"]])

    // 重复上报同一 (扇区,键位): 第二次应是无害 no-op, 不能误删别人的项
    r = run([
        "Sector 07 - Unknown Key A               Unknown Key B\n",
        "Sector 09 - Unknown Key A               Unknown Key B\n",
        "Sector: 7, type A, probe 1, distance 1 ......\n",
        "  Found Key: A [112233445566]\n",
        "Sector: 7, type A, probe 2, distance 2 ......\n",
        "  Found Key: A [112233445566]\n"
    ])
    eq("重复上报不误删其它扇区", r.unknown, [[7, "B"], [9, "A"], [9, "B"]])
}

console.log("[parse] 9. 恢复格式的分块不变性")
{
    const text =
        "Sector 06 - Found   Key A: ffffffffffff Found   Key B: a0a1a2a3a4a5\n" +
        "Sector 07 - Unknown Key A               Unknown Key B\n" +
        "Sector: 7, type A, probe 3, distance 12456 ......\n" +
        "  Found Key: A [112233445566]\n"
    const collect = (chunks) => {
        const p = createKeyInfoParser()
        const out = []
        for (const c of chunks) out.push(...p.push(c))
        return out
    }
    const base = collect([text])
    eq("整块输入: 产出 5 条 (2+2+1)", base.length, 5)
    eq("最后一条是恢复的密钥", base[4], {key: "112233445566", sector: 7, type: "A", recovered: true})
    // 61/62 是把换行切开的粒度, 最容易暴露跨行状态丢失
    for (const size of [1, 13, 60, 61, 62, 63, 64, 150, 512]) {
        eq(`分块 ${size}B: 序列与整块一致`, collect(split(text, size)), base)
    }
}

console.log("[parse] 10. 两个阶段的正则互不误匹配")
{
    const p = createKeyInfoParser()
    eq("普通扇区行不触发恢复分支", p.push("Sector 07 - Unknown Key A               Unknown Key B\n").filter((r) => r.recovered), [])
    const p2 = createKeyInfoParser()
    p2.push("Sector: 7, type A, probe 3, distance 1 ......\n")
    eq("恢复行不触发阶段一的重复计入", p2.push("  Found Key: A [112233445566]\n").filter((r) => !r.recovered), [])
    const p3 = createKeyInfoParser()
    eq("非 Mifare Classic 杂项输出不产出", p3.push("Found Mifare Classic Mini tag\n"), [])
    const p4 = createKeyInfoParser()
    p4.push("Sector: 7, type A, probe 1 ......\n")
    eq("方括号内非 12 位 hex 不算恢复密钥", p4.push("  Found Key: A [123456789]\n"), [])
    const p5 = createKeyInfoParser()
    p5.push("Sector: 7, type A, probe 1 ......\n")
    eq("缺方括号不算恢复密钥", p5.push("  Found Key: A 112233445566\n"), [])
    const p6 = createKeyInfoParser()
    p6.push("Sector: 7, type A, probe 1 ......\n")
    eq("Data read 揭示 B 键的格式不被误收", p6.push("  Data read with Key A revealed Key B: [aabbccddeeff] - checking Auth: OK\n"), [])
    const p7 = createKeyInfoParser()
    p7.push("Sector: 12, type A, probe 1 ......\n")
    eq("扇区号大于 9 (工具用 %d 不补零)", p7.push("  Found Key: A [112233445566]\n").map((r) => r.sector), [12])
}

console.log("[parse] 11. 日志进度行 \\33[2K 覆盖处理 (logUtil)")
{
    const ESC = "\x1b"
    eq("普通文本原样追加", appendLogChunk("aaa\n", "bbb\n"), "aaa\nbbb\n")
    eq("单次覆盖: 擦掉进行中的行再写入", appendLogChunk("aaa\n", `\r${ESC}[2KProgress X`), "aaa\nProgress X")
    eq("日志以换行结尾: 当前行是空行, 新内容起新行", appendLogChunk("aaa\n", `${ESC}[2KB`), "aaa\nB")
    eq("单行日志被整体擦掉", appendLogChunk("aaa", `\r${ESC}[2KB`), "B")
    eq("空日志覆盖", appendLogChunk("", `\r${ESC}[2KB`), "B")
    // Tauri 端按行缓冲: 无换行进度攒成一行, 一行里连带多个覆盖标记, 只应留下最后一条
    const accumulated = `\r${ESC}[2KProgress 0/100\r${ESC}[2KProgress 1/100\r${ESC}[2KProgress 1000/100\n\n`
    const r = appendLogChunk("aaa\n", accumulated)
    eq("Tauri 积压行: 只留最后一条进度", r, "aaa\nProgress 1000/100\n\n")
    eq("Tauri 积压行: 无转义序列残留", !r.includes(ESC), true)
    eq("带换行的进度行各自保留", appendLogChunk("aaa\n", `\r${ESC}[2KA\n\r${ESC}[2KB\n`), "aaa\nA\nB\n")
    eq("标记前的普通行不误擦", appendLogChunk("aaa\n", `X\n\r${ESC}[2KY`), "aaa\nX\nY")
    eq("标记前缺 \\r 也识别", appendLogChunk("aaa", `${ESC}[2KB`), "B")
    eq("eraseLastLine: 删末尾未换行的一行(含内容)", eraseLastLine("aaa\nbbb"), "aaa\n")
    eq("eraseLastLine: 以换行结尾无变化", eraseLastLine("aaa\nbbb\n"), "aaa\nbbb\n")
    eq("eraseLastLine: 唯一一行清空", eraseLastLine("bbb"), "")
}

console.log(failed === 0 ? "[parse] PASSED" : `[parse] FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
