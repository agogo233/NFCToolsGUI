let currentFilePath = null
const $checkResult = $('#check-result')

// 体检 / 修复 / 导出密钥 —— 全部走 dumpTools.js, 该模块与主进程无耦合, 两个端口共用
$('#check-dump').click(() => {
    const result = checkDump(getHexData())
    renderCheckResult(result)
    markErrorSectors(result)
})

$('#fix-dump').click(() => {
    const {hex, fixed} = fixDump(getHexData())
    if (fixed.length === 0) {
        renderCheckResult(null, i18n("html_fix_none"))
        markErrorSectors(checkDump(hex))
        return
    }
    // 修复后直接写回编辑器, 让用户看到结果并自行决定是否保存
    applyHexData(hex)
    renderCheckResult(checkDump(hex), formatFixSummary(fixed))
})

$('#export-keys').click(() => {
    const dict = dumpToKeyDict(getHexData())
    if (!dict) {
        renderCheckResult(checkDump(getHexData()))
        return
    }
    const baseName = currentFilePath ? currentFilePath.split(/[\/\\]/g).pop().replace(/\.[^.]*$/, '') : "dump"
    window['electronAPI'].execAction('dump-editor-export-keys', {name: `${baseName}.dic`, content: dict})
})

function formatError(error) {
    if (error.code === "bcc") return `${i18n("html_sector")} ${error.sector}: ${i18n("html_error_bcc")} (${error.detail})`
    if (error.code === "acl-corrupt") return `${i18n("html_sector")} ${error.sector}: ${i18n("html_error_acl_corrupt")}`
    if (error.code === "acl-invalid") return `${i18n("html_sector")} ${error.sector}: ${i18n("html_error_acl_invalid")}`
    if (error.code === "size") return `${i18n("html_error_size")}${error.detail}${i18n("html_error_size_bytes")}`
    return i18n("html_error_not_hex")
}

function formatFixSummary(fixed) {
    return `${i18n("html_fix_summary")}${fixed.map((f) => `${i18n("html_sector")} ${f.sector}`).join(", ")}`
}

function renderCheckResult(result, prefix) {
    $checkResult.empty()
    if (!result) {
        // 先清掉错误色: "无需修复"不是错误, 沿用上一次的红色会误导
        $checkResult.removeClass("has-error").text(prefix || "")
        return
    }
    if (result.ok) {
        $checkResult.removeClass("has-error").text(prefix ? `${prefix} / ${i18n("html_check_all_ok")}` : i18n("html_check_all_ok"))
        return
    }
    $checkResult.addClass("has-error")
    if (prefix) $checkResult.append($('<span>').addClass("check-line").text(prefix))
    result.errors.forEach((error) => {
        $checkResult.append($('<span>').addClass("check-line").text(formatError(error)))
    })
}

// 错误扇区在编辑器里标红。编辑器按每 4 行一组渲染, 与扇区实际大小无关,
// 大卡上两者不是一一对应 (4K 卡的 32 号以后每扇区 16 块), 必须换算而不是拿扇区号当下标。
function markErrorSectors(result) {
    const inputs = $('#binary-data-content').find('.binary-input')
    inputs.removeClass("has-error")
    if (!result || result.blockSize <= 0) return
    result.errors.forEach((error) => {
        if (error.sector === null) return
        inputs.eq(sectorGroupIndex(error.sector, result.blockSize)).addClass("has-error")
    })
}

// 把新的 hex 写回编辑器, 保留"每扇区 4 行"的分组与着色
function applyHexData(hex) {
    const bytes = hexToBytes(hex)
    if (bytes === null) return
    const hexDataArray = bytesToHex(bytes).match(/.{1,32}/g)
    if (!hexDataArray) return
    const sectors = []
    for (let i = 0; i < hexDataArray.length; i += 4) {
        sectors.push((hexDataArray.slice(i, i + 4)).join("\n"))
    }
    renderSectors(sectors)
}

// 按每 4 行一组重建编辑区。打开文件与修复后回填走同一条路径。
function renderSectors(sectors) {
    const container = $('#binary-data-content')
    container.empty()
    let sector = 0
    sectors.forEach((lines, i) => {
        const label = $(`<span class="textarea-label">${i18n("html_sector")} ${sector++}</span>`)
        const textarea = $(`<div class="binary-input" wrap="off" spellcheck="false" contenteditable="true">${updateTagColor(lines, !i)}</div>`)
        container.append($('<br>'))
        container.append(label)
        container.append(textarea)
        label.width(textarea.width())
    })
}

window['electronAPI'].onUpdateDumpEditorFile((event, data) => {
    window['electronAPI'].execAction('dump-editor-choose-file', data)
})

$('#drag').on('dragstart', (e) => {
    e.preventDefault()
    if (currentFilePath) window['electronAPI'].startDrag(currentFilePath)
})

// buttons
$('#choose-file').click(() => {window['electronAPI'].execAction('dump-editor-choose-file')})
const getHexData = () => $('.binary-input').map((i, el) => el.innerText).get().join('').replace(/\n/g, '')
$('#save-file').click(() => {
    if (!currentFilePath || !getHexData()) {
        alert(i18n("html_data_format_wrong"))
        return
    }
    if (checkData(true)) {
        window['electronAPI'].execAction(
            'dump-editor-save',
            {
                url: currentFilePath,
                hexData: getHexData()
            }
        )
    } else {
        alert(i18n("html_data_format_wrong"))
    }
})
$('#save-as-file').click(() => {
    if (!currentFilePath || !getHexData()) {
        alert(i18n("html_data_format_wrong"))
        return
    }
    if (checkData(true)) {
        window['electronAPI'].execAction(
            'dump-editor-save',
            {
                url: currentFilePath,
                saveAs: true,
                hexData: getHexData()
            }
        )
    } else {
        alert(i18n("html_data_format_wrong"))
    }
})
$('#update-tag-color').click(() => {
    if (checkData()) {
        $('#binary-data-content').find('.binary-input').each((i, item) => {
            item.innerHTML = updateTagColor(item.innerText, !i)
        })
    } else {
        alert(hasNonClassicLayout() ? i18n("html_data_not_classic_layout") : i18n("html_data_format_wrong"))
    }
})

window['electronAPI'].onOpenDumpFile((event, data) => {
    currentFilePath = data.url

    const pathArray = data.url.split(/[\/\\]/g)
    $('#current-file').text(pathArray[pathArray.length - 1])

    renderSectors(data.data)
})

window['electronAPI'].onSavedDumpFile((event, data) => {
    if (data && data.url) {
        currentFilePath = data.url
        $('#current-file').text(data.url.split(/[\/\\]/g).pop())
    }
    alert(i18n("html_save_success"))
})

function updateTagColor(data, isBlock0 = false) {
    const splitData = data.split("\n")
    // 少于 4 行的分组不是 Mifare Classic 扇区布局 (如 Ultralight), 没有第 4 行可着色
    if (splitData.length < 4) return data
    if (isBlock0) {splitData[0] = `<span class="uid">${splitData[0]}</span>`}
    splitData[3] = `<span class="keyA">${splitData[3].substring(0, 12)}</span>` +
        `<span class="accessControl">${splitData[3].substring(12, 18)}</span>` +
        `${splitData[3].substring(18, 20)}` +
        `<span class="keyB">${splitData[3].substring(20)}</span>`
    return splitData.join("\n")
}

// 分组不足 4 行 = 不是 Mifare Classic 扇区布局, 与"内容不是合法 hex"是两回事, 提示要区分开
function hasNonClassicLayout() {
    return $('#binary-data-content').find('.binary-input').toArray()
        .some((item) => item.innerText.split("\n").length < 4)
}

function checkData(isCheckContent = false) {
    let isDataValid = true

    const styles = {
        invalid: {
            'border-color': '#e96666',
            'box-shadow': 'inset 0 1px 1px rgba(0,0,0,.075),0 0 8px rgba(223,102,102,.6)'
        },
        valid: {
            'border-color': '#ccc',
            'box-shadow': 'none'
        }
    }

    $('#binary-data-content').find('.binary-input').each((i, item) => {
        const splitData = item.innerText.split("\n");
        const valid = splitData.length === 4 && splitData.every(data => data.length === 32 && (!isCheckContent || /^[0-9A-Fa-f]+$/.test(data)));
        $(item).css(valid ? styles.valid : styles.invalid);
        isDataValid = isDataValid && valid;
    });
    return isDataValid
}