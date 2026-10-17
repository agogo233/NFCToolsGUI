// 卡数据体检与修复的回归测试: node test/parse/dumpTools.test.js
// ACL 判定逐行对照 MifareOneTool 的 Utils.ReadAC / ReadRAC, 这里的夹具是它的行为快照,
// 改动位运算前必须先让这些用例继续通过。
const {
    checkDump, fixDump, dumpToKeyDict, hexToBytes, bytesToHex,
    sectorTrailerBlock, sectorGroupIndex, sectorCount,
    sectorTrailerBlockOf, safeFileName,
    groupSector, groupHasTrailer, groupLabel,
    BLOCK_SIZE, FIX_ACCESS_BYTES
} = require("../../src/renderer/js/dumpTools")

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

// 造一份 size 字节的卡数据: 全部扇区都用默认访问位, 块 0 用合法 BCC。
// 尾块定位复用被测模块的 sectorTrailerBlock。这样做只能保证"夹具与实现对扇区布局的
// 理解一致", 挡不住映射本身写错 —— 真正钉住映射的是下面 section 11 里的字面量锚点
// (143/255 等), 那些断言不经过 helper, helper 回退时它们会先红。
function makeDump(size, fill) {
    const bytes = new Array(size).fill(0)
    for (let i = 0; i < size; i++) bytes[i] = fill === undefined ? 0xaa : fill
    const blockCount = size / BLOCK_SIZE
    for (let s = 0; s < blockCount; s++) {
        const trailer = sectorTrailerBlock(s, blockCount) * BLOCK_SIZE
        if (trailer + BLOCK_SIZE > size) break
        for (let i = 0; i < FIX_ACCESS_BYTES.length; i++) bytes[trailer + 6 + i] = FIX_ACCESS_BYTES[i]
    }
    // 扇区 0 块 0 的 BCC
    bytes[0] = 0x01; bytes[1] = 0x02; bytes[2] = 0x03; bytes[3] = 0x04
    bytes[4] = 0x01 ^ 0x02 ^ 0x03 ^ 0x04
    return bytes
}
const trailerOffsetOf = (sector, size) =>
    sectorTrailerBlock(sector, size / BLOCK_SIZE) * BLOCK_SIZE
// 扇区首块的字节偏移, 用于"改数据块不该被误判/误改"这类断言
const firstOffsetOf = (sector, size) => {
    const blockCount = size / BLOCK_SIZE
    const first = blockCount <= 128 ? sector * 4 : (sector < 32 ? sector * 4 : 128 + (sector - 32) * 16)
    return first * BLOCK_SIZE
}

console.log("[parse] 1. hex 转换")
{
    eq("空串", hexToBytes(""), [])
    eq("奇数长度返回 null", hexToBytes("abc"), null)
    eq("非 hex 字符返回 null", hexToBytes("zz"), null)
    eq("忽略空白", bytesToHex(hexToBytes("01 02\n03")), "010203")
    eq("大写输入", bytesToHex(hexToBytes("AABB")), "aabb")
    eq("null 输入", hexToBytes(null), null)
}

console.log("[parse] 2. 合法卡数据无错")
{
    for (const size of [1024, 2048, 4096]) {
        const r = checkDump(bytesToHex(makeDump(size)))
        check(`容量 ${size} 判定正常`, r.ok, JSON.stringify(r.errors))
        eq(`容量 ${size} 扇区数`, r.errors.length, 0)
    }
}

console.log("[parse] 3. BCC 校验只对扇区 0 生效")
{
    const bytes = makeDump(1024)
    bytes[4] ^= 0xff
    const r = checkDump(bytesToHex(bytes))
    eq("扇区 0 BCC 错被检出", r.errors.map((e) => e.code), ["bcc"])
    eq("给出期望的 BCC", r.errors[0].detail, bytesToHex([bytes[0] ^ bytes[1] ^ bytes[2] ^ bytes[3]]))

    // 其它扇区块 0 的第 5 字节不是校验值, 改了也不该报错
    const b2 = makeDump(1024)
    const other = firstOffsetOf(1, 1024)
    b2[other + 4] ^= 0xff
    check("扇区 1 块 0 改动不误报", checkDump(bytesToHex(b2)).ok)
}

console.log("[parse] 4. 访问位判定")
{
    // 全 0 与全 FF 都是非法访问位 (正反码不一致)
    for (const fill of [[0, 0, 0, 0], [0xff, 0xff, 0xff, 0xff]]) {
        const bytes = makeDump(1024)
        const t = trailerOffsetOf(3, 1024)
        bytes[t + 6] = fill[0]; bytes[t + 7] = fill[1]; bytes[t + 8] = fill[2]; bytes[t + 9] = fill[3]
        const r = checkDump(bytesToHex(bytes))
        eq(`访问位 ${fill.join(",")} 判为 acl-corrupt`, r.errors.map((e) => [e.sector, e.code]), [[3, "acl-corrupt"]])
    }

    // NXP 默认访问位同样应判为正常 —— 两套位序都源自同一张卡的实际出厂值
    const nxp = makeDump(1024)
    const t = trailerOffsetOf(2, 1024)
    nxp[t + 6] = 0x78; nxp[t + 7] = 0x77; nxp[t + 8] = 0x88; nxp[t + 9] = 0x69
    check("NXP 默认访问位判为正常", checkDump(bytesToHex(nxp)).ok)

    // b9 是用户字节, 不参与判定
    const u = makeDump(1024)
    const t2 = trailerOffsetOf(4, 1024)
    u[t2 + 9] = 0x12
    check("改用户字节不误报", checkDump(bytesToHex(u)).ok)

    // 合法访问位恰有 4096 组 (12 个自由位)。这里只抽样确认不是"多数即合法"
    const good = makeDump(1024)
    const t3 = trailerOffsetOf(5, 1024)
    good[t3 + 7] ^= 0x01
    eq("翻转 b7 最低位即判损坏", checkDump(bytesToHex(good)).errors.map((e) => e.code), ["acl-corrupt"])
}

console.log("[parse] 5. 容量检查")
{
    eq("长度非 16 倍数", checkDump(bytesToHex(new Array(1000).fill(0))).errors[0].code, "size")
    eq("非 1K/2K/4K", checkDump(bytesToHex(new Array(512).fill(0))).errors[0].code, "size")
    eq("非 hex", checkDump("nothex").errors[0].code, "not-hex")
    eq("错误详情带实际长度", checkDump(bytesToHex(new Array(512).fill(0))).errors[0].detail, "512")
}

console.log("[parse] 6. 修复")
{
    const bytes = makeDump(1024)
    bytes[4] ^= 0xff
    const t = trailerOffsetOf(7, 1024)
    bytes[t + 6] = 0; bytes[t + 7] = 0; bytes[t + 8] = 0
    const fixed = fixDump(bytesToHex(bytes))
    const after = checkDump(fixed.hex)
    check("修复后体检通过", after.ok, JSON.stringify(after.errors))
    eq("修复项数量", fixed.fixed.map((f) => [f.sector, f.code]), [[0, "bcc"], [7, "acl-corrupt"]])

    const fb = hexToBytes(fixed.hex)
    eq("BCC 重算正确", fb[4], fb[0] ^ fb[1] ^ fb[2] ^ fb[3])
    eq("访问位写回默认", [fb[t + 6], fb[t + 7], fb[t + 8]], FIX_ACCESS_BYTES)
}

console.log("[parse] 7. 修复保留用户字节")
{
    const bytes = makeDump(1024)
    const t = trailerOffsetOf(6, 1024)
    bytes[t + 9] = 0xa5
    bytes[t + 7] = 0xff
    const fb = hexToBytes(fixDump(bytesToHex(bytes)).hex)
    eq("b9 原样保留", fb[t + 9], 0xa5)
}

console.log("[parse] 8. 修复不越界")
{
    // 参考实现对所有扇区的块 0 都写 BCC, 会破坏数据块; 这里必须只改扇区 0
    const bytes = makeDump(1024)
    for (let s = 1; s < 16; s++) {
        const first = firstOffsetOf(s, 1024)
        bytes[first + 4] ^= 0xff
    }
    const fb = hexToBytes(fixDump(bytesToHex(bytes)).hex)
    let changed = 0
    for (let s = 1; s < 16; s++) {
        const first = firstOffsetOf(s, 1024)
        if (fb[first + 4] !== bytes[first + 4]) changed++
    }
    eq("其它扇区的块 0 未被改动", changed, 0)
    eq("其它扇区的块 0 改动不算错误", checkDump(bytesToHex(fb)).errors.length, 0)
}

console.log("[parse] 9. 修复的输入边界")
{
    eq("非 hex 原样返回", fixDump("zz").hex, "zz")
    eq("奇数长度只做 hex 规范化", fixDump("abc").fixed, [])
    eq("512 字节不修复", fixDump(bytesToHex(new Array(512).fill(0))).fixed, [])
    const good = makeDump(1024)
    eq("正常数据无需修复", fixDump(bytesToHex(good)).fixed, [])
}

console.log("[parse] 10. 密钥字典导出")
{
    const bytes = makeDump(1024)
    const t0 = trailerOffsetOf(0, 1024)
    const t1 = trailerOffsetOf(1, 1024)
    for (let i = 0; i < 6; i++) {
        bytes[t0 + i] = 0xaa
        bytes[t0 + 10 + i] = 0xbb
        bytes[t1 + i] = 0xcc
        bytes[t1 + 10 + i] = 0xdd
    }
    const dict = dumpToKeyDict(bytesToHex(bytes))
    const lines = dict.split("\n")
    eq("每扇区两个键 + 其余扇区的默认 FF 键去重后只剩 4 个", lines.length, 4)
    check("含扇区 0 KeyA", lines.indexOf("aaaaaaaaaaaa") >= 0, dict)
    check("含扇区 0 KeyB", lines.indexOf("bbbbbbbbbbbb") >= 0, dict)
    check("含扇区 1 KeyA", lines.indexOf("cccccccccccc") >= 0, dict)
    check("含扇区 1 KeyB", lines.indexOf("dddddddddddd") >= 0, dict)
    check("每行 12 位 hex", lines.every((l) => /^[0-9a-f]{12}$/.test(l)), dict)
    check("无重复", new Set(lines).size === lines.length)

    eq("非 hex 返回空串", dumpToKeyDict("zz"), "")
    eq("长度非 16 倍数返回空串", dumpToKeyDict(bytesToHex(new Array(500).fill(0))), "")
    check("默认全 F 卡导出 32 键", dumpToKeyDict(bytesToHex(makeDump(1024))).split("\n").length === 1)
}

console.log("[parse] 11. 4K 卡 32 号以后的尾块定位")
{
    const SIZE = 4096
    const BC = SIZE / BLOCK_SIZE
    // 尾块必须是每扇区最后一块: 前 32 个扇区 4 块 -> first+3, 后 8 个扇区 16 块 -> first+15。
    // 这组绝对块号是本用例的锚点, 定位一旦回退到 "首块+3" 就会被下面几条抓住。
    eq("扇区 31 尾块是块 127", sectorTrailerBlock(31, BC), 127)
    eq("扇区 32 尾块是块 143", sectorTrailerBlock(32, BC), 143)
    eq("扇区 39 尾块是块 255", sectorTrailerBlock(39, BC), 255)
    // 小卡与 2K 每扇区恒 4 块, 行为不得改变
    eq("1K 扇区 3 尾块是块 15", sectorTrailerBlock(3, 1024 / BLOCK_SIZE), 15)
    eq("2K 扇区 31 尾块是块 127", sectorTrailerBlock(31, 2048 / BLOCK_SIZE), 127)
    // 扇区总数: 少算会让尾部扇区被静默漏检/漏修/漏导出, 且不报任何错
    eq("1K 16 个扇区", sectorCount(1024 / BLOCK_SIZE), 16)
    eq("2K 32 个扇区", sectorCount(2048 / BLOCK_SIZE), 32)
    eq("4K 40 个扇区", sectorCount(BC), 40)

    // 全卡合法时不该报错 —— 定位回退到首块+3 会把 32..39 号的数据块当成尾块而误报
    const good = makeDump(SIZE)
    const rg = checkDump(bytesToHex(good))
    check("全合法 4K 卡判定正常", rg.ok, JSON.stringify(rg.errors.map((e) => [e.sector, e.code])))

    // 只破坏扇区 32 的真尾块, 必须且只能报扇区 32。
    // 偏移一律写死 143 * BLOCK_SIZE, 不走 trailerOffsetOf —— 后者内部调的就是被测的
    // sectorTrailerBlock, helper 一旦回退到"首块+3", 用它取偏移会让夹具跟着错到块 131,
    // 下面三条行为断言就全成了自证。
    const T32 = 143 * BLOCK_SIZE
    const bad = makeDump(SIZE)
    bad[T32 + 6] = 0; bad[T32 + 7] = 0; bad[T32 + 8] = 0
    eq("仅扇区 32 尾块损坏时被精确检出",
        checkDump(bytesToHex(bad)).errors.map((e) => [e.sector, e.code]),
        [[32, "acl-corrupt"]])

    // 修复只许动真尾块, 一个数据字节都不能碰 (定位回退时这里会改到块 131)
    const fixed = fixDump(bytesToHex(bad))
    eq("修复项只有扇区 32", fixed.fixed.map((f) => [f.sector, f.code]), [[32, "acl-corrupt"]])
    const after = hexToBytes(fixed.hex)
    check("修复后体检通过", checkDump(fixed.hex).ok)
    eq("只改动了真尾块的 3 个访问位字节",
        bad.map((v, i) => (v !== after[i] ? i : -1)).filter((i) => i >= 0),
        [T32 + 6, T32 + 7, T32 + 8])
    // 扇区 32 的首块是数据块 (块 128), 修复前后整块 16 字节必须相同。
    // 定位回退时被改写的正是这块的字节 6..8, 所以这里要覆盖整块而不是前 4 字节。
    eq("扇区 32 的数据块整块未被改动",
        after.slice(128 * BLOCK_SIZE, 129 * BLOCK_SIZE),
        bad.slice(128 * BLOCK_SIZE, 129 * BLOCK_SIZE))

    // 密钥导出: 尾块(块 143)里的 KeyA/KeyB 要被读出来;
    // 数据块(块 131, 定位回退时会误取的那块)起始 6 字节不能被当成密钥
    const dict = makeDump(SIZE)
    for (let i = 0; i < 6; i++) {
        dict[T32 + i] = 0x11
        dict[T32 + 10 + i] = 0x22
        dict[131 * BLOCK_SIZE + i] = 0x33
    }
    const dlines = dumpToKeyDict(bytesToHex(dict)).split("\n")
    check("导出含扇区 32 的 KeyA", dlines.indexOf("111111111111") >= 0, dlines.join(","))
    check("导出含扇区 32 的 KeyB", dlines.indexOf("222222222222") >= 0, dlines.join(","))
    check("定位回退会误取的数据块(块 131)未被当成密钥", dlines.indexOf("333333333333") < 0, dlines.join(","))

    // 编辑器按每 4 行一组渲染, 标红要落在尾块所在的那一组: 块 143 属于第 35 组
    eq("1K 扇区 3 标红组等于扇区号", sectorGroupIndex(3, 1024), 3)
    eq("4K 扇区 32 标红落在尾块所在组", sectorGroupIndex(32, SIZE), 35)
}

console.log("[parse] 12. 编辑器分组与真实扇区的对应")
{
    // 编辑器固定每 4 块一组。4K 的 32 号以后一扇区占 16 块 = 4 组, 组边界与扇区边界
    // 对齐, 所以能只靠组下标换算出真实扇区, 不必改渲染布局。
    // 1K/2K 每扇区恰好一组 —— 标签必须与旧的顺序计数器完全一致, 任何变化都是回归。
    eq("1K 每组都含尾块",
        [0, 3, 15].map((g) => groupHasTrailer(g, 1024)), [true, true, true])
    eq("2K 每组都含尾块",
        [0, 17, 31].map((g) => groupHasTrailer(g, 2048)), [true, true, true])
    eq("1K 标签就是扇区号",
        [0, 3, 15].map((g) => groupLabel(g, 1024)), ["0", "3", "15"])
    eq("2K 标签就是扇区号",
        [0, 17, 31].map((g) => groupLabel(g, 2048)), ["0", "17", "31"])
    eq("1K 组号即扇区号", [0, 3, 15].map((g) => groupSector(g, 1024)), [0, 3, 15])
    eq("2K 组号即扇区号", [0, 17, 31].map((g) => groupSector(g, 2048)), [0, 17, 31])

    // 4K 前 32 组仍是一组一扇区, 与 1K 行为相同
    eq("4K 前 32 组标签就是扇区号",
        [0, 17, 31].map((g) => groupLabel(g, 4096)), ["0", "17", "31"])
    eq("4K 前 32 组每组都含尾块",
        [0, 17, 31].map((g) => groupHasTrailer(g, 4096)), [true, true, true])

    // 4K 后 32 组: 每 4 组一个扇区。扇区 32 的尾块是块 143, 落在第 35 组,
    // 所以标签必须是 "32 (4/4)" —— 早先直接用组序号会标成 "扇区 35", 与体检结果
    // 报的 "扇区 32" 对不上。
    eq("4K 扇区 32 占组 32..35 且标签带部分号",
        [32, 33, 34, 35].map((g) => groupLabel(g, 4096)),
        ["32 (1/4)", "32 (2/4)", "32 (3/4)", "32 (4/4)"])
    eq("4K 这 4 组都归属扇区 32",
        [32, 33, 34, 35].map((g) => groupSector(g, 4096)), [32, 32, 32, 32])
    // 只有最后一组是真尾块, 前三组的第 4 行是普通数据块
    eq("4K 扇区 32 的四组中只有最后一组含尾块",
        [32, 33, 34, 35].map((g) => groupHasTrailer(g, 4096)),
        [false, false, false, true])
    eq("4K 扇区 39 尾块落在最后一组",
        [60, 61, 62, 63].map((g) => groupLabel(g, 4096)),
        ["39 (1/4)", "39 (2/4)", "39 (3/4)", "39 (4/4)"])
    eq("4K 全部 64 组里含尾块的恰为 9 个大扇区尾块 + 前 32 组",
        Array.from({length: 64}, (_, g) => groupHasTrailer(g, 4096))
            .map((has, g) => (has ? g : -1)).filter((g) => g >= 0),
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
            16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
            35, 39, 43, 47, 51, 55, 59, 63])

    // 容量既非 1K/2K/4K 时 (文件被截断或本就不是 Classic 布局) 不能换算扇区,
    // 必须退回组序号。早先按"组数*16"取容量时, 1000 字节会被凑成 63 组 -> 1008 ->
    // 落进 4K 区间, 于是一张坏卡被标成 "扇区 39 (3/4)"。
    eq("非合法容量退回组序号(1000 字节)",
        [0, 31, 32, 62].map((g) => groupLabel(g, 1000)), ["0", "31", "32", "62"])
    eq("非合法容量不再谎称尾块所在",
        [32, 34, 35].map((g) => groupHasTrailer(g, 1000)), [true, true, true])
    eq("超过 4K 的输入退回组序号",
        [0, 32, 63].map((g) => groupLabel(g, 8192)), ["0", "32", "63"])
    eq("0 字节不抛异常", groupLabel(0, 0), "0")
}

console.log("[parse] 13. 传给工具的扇区尾块块号")
{
    // 硬嵌套把扇区号换算成块号传给 libnfc-collect (它收块号, 不是扇区号)。
    // 4K 卡 32 号以后每扇区 16 块, 早先用 (扇区+1)*4-1 会把 33 号以后的扇区指到
    // 数据块上, 认证必然失败且不报错。这几个绝对块号是跨端口的共同锚点:
    // src-tauri 的 sector_trailer_block 必须与此一致, 两边任一回退都会在这里被抓到。
    eq("扇区 0 是块 3", sectorTrailerBlockOf(0), 3)
    eq("扇区 31 是块 127", sectorTrailerBlockOf(31), 127)
    eq("扇区 32 是块 143", sectorTrailerBlockOf(32), 143)
    eq("扇区 33 是块 159", sectorTrailerBlockOf(33), 159)
    eq("扇区 39 是块 255", sectorTrailerBlockOf(39), 255)

    // 同一扇区两条路径必须取到同一块: 体检/修复走 sectorTrailerBlock,
    // 采集走本函数, 不一致就会一个说数据块、一个说密钥块
    const BC = 4096 / BLOCK_SIZE
    eq("与 sectorTrailerBlock 的 4K 结果一致",
        [0, 31, 32, 33, 35, 39].map((s) => sectorTrailerBlockOf(s)),
        [0, 31, 32, 33, 35, 39].map((s) => sectorTrailerBlock(s, BC)))
}

console.log("[parse] 14. dump 文件名的安全校验")
{
    // 删除/重命名 dump 前必须只放行纯文件名。path.join 遇到绝对路径或 .. 段会逃出
    // dumpfiles 目录 (Windows 下反斜杠同样生效); 空名、"."、 ".." 都无法定位到文件。
    // 与 src-tauri 的 safe_file_name 保持同一规则。
    eq("正常文件名放行", safeFileName("a.mfd"), "a.mfd")
    eq("相对路径拒绝", safeFileName("..\\evil.mfd"), null)
    eq("斜杠路径拒绝", safeFileName("../evil.mfd"), null)
    eq("反斜杠路径拒绝", safeFileName("..\\..\\x.mfd"), null)
    eq("绝对路径拒绝", safeFileName("C:\\x.mfd"), null)
    eq("空名拒绝", safeFileName(""), null)
    eq("'.'拒绝", safeFileName("."), null)
    eq("'..'拒绝", safeFileName(".."), null)
    eq("带目录拒绝", safeFileName("sub/a.mfd"), null)
}

console.log(failed === 0 ? "[parse-dump] PASSED" : `[parse-dump] FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
