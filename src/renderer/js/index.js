let mainProcess = window["electronAPI"]
let currentUSBPorts = []
let isConnectingDevice = false
let isLockScroll = false
let isTimerRunning = false;
let intervalID = undefined;
let timerSecond = 0
const $statusText = $("#status-text")

if (mainProcess.platform !== "darwin") {
    const titleArea = $(".title")
    $(".windows-control").show()
    titleArea.css("float", "none")
    titleArea.css("margin-left", "10px")
    $("#app-title-icon").css("display", "inline-block")
}

mainProcess.getVersion().then((v) =>{$("#version-value").html(v)})

// 接收更新 Log 输出
// 显示区只保留最近 LOG_DISPLAY_LIMIT 个字符: 长时间任务(字典攻击数小时)会把
// textarea.value 撑到很大, 每次追加都要重排, 越跑越卡。完整内容另存在
// fullLog 里, "保存日志" 取的是完整内容, 因此截断只影响显示。
const LOG_DISPLAY_LIMIT = 500000
let fullLog = ""

mainProcess.onUpdateLogOutput((_event, value) => {
    const textarea = document.getElementById("log")
    if (value.indexOf("\33[2K") >= 0) {
        // 回退整行以原地覆盖进度条。没有换行时 lastIndexOf 返回 -1, substring(0, -1)
        // 会把整个日志清空, 必须挡掉。
        const lastBreak = textarea.value.lastIndexOf('\n')
        if (lastBreak >= 0) textarea.value = textarea.value.substring(0, lastBreak)
        value = value.replace("\33[2K", "")
    }

    fullLog += value
    textarea.value += value
    if (textarea.value.length > LOG_DISPLAY_LIMIT) {
        textarea.value = textarea.value.substring(textarea.value.length - LOG_DISPLAY_LIMIT)
    }
    if (!isLockScroll && value.indexOf("\n") >= 0) {
        textarea.scroll({top: textarea.scrollHeight, left: 0, behavior: "smooth"})
    }
})

// 接收状态更新
mainProcess.onUpdateStatus((_event, value) => {
    $statusText.html(value["text"])
    $statusText.prop("title", value["text"])

    const statusIndicator = $("#status-indicator")
    switch (value["indicator"]) {
        case "free":
            statusIndicator.css("background-color", "transparent")
            resetStatus(true)
            hideProgress()
            break
        case "running":
            statusIndicator.css("background-color", "green")

            if (isTimerRunning) return
            isTimerRunning = true
            let double = function (m) {
                return m < 10 ? `0${m}` : `${m}`;
            }
            intervalID = setInterval(function () {
                timerSecond++;
                const hour = parseInt(timerSecond / 3600);
                const min = parseInt(timerSecond / 60) % 60;
                const sec = timerSecond % 60;
                $("#timer-value").html( `${double(hour)}:${double(min)}:${double(sec)}`)
            }, 1000);
            break
        case "error":
            statusIndicator.css("background-color", "red")
            resetStatus(true)
            hideProgress()
    }
})

// 接收更新 USB 设列表
mainProcess.onUpdateUSBDevices((_event, value) => {
    if (isListEqual(value, currentUSBPorts)) return
    currentUSBPorts = value
    const usbPorts = $(".dropdown-menu[data-id='usb-port']")
    usbPorts.empty()

    value.forEach((v) => {
        const deviceItemSpan = document.createElement("span")
        deviceItemSpan.setAttribute("class", "text")
        deviceItemSpan.innerText = v.replace(mainProcess.devicePrefix, "")

        const deviceItem = document.createElement("li")
        deviceItem.setAttribute("class", "menu-item")
        deviceItem.setAttribute("data-value", v)
        deviceItem.setAttribute("data-label", deviceItemSpan.innerText)
        deviceItem.appendChild(deviceItemSpan)
        usbPorts.append(deviceItem)
    })
})

// 显示引导条
mainProcess.onShowGuidance((_event, value) => {
    showGuidanceLocal(value.text, value.buttons)
})

// 解卡完成, dump 已保存
mainProcess.onDumpSaved((_event, value) => {
    const dumpName = value.filename.split("/").pop().split("\\").pop()
    appendEvent("success", `${i18n("event_dump_saved")}${dumpName}`)
    showGuidanceLocal(`${i18n("guidance_dump_saved")}${dumpName}`, [
        {action: "write-IC", arg: value.filename, label: i18n("html_write_this_dump")},
        {action: "open-dump-folder", label: i18n("html_open_dump_folder")}
    ])
})

function showGuidanceLocal(text, buttons) {
    const bar = document.getElementById("guidance-bar")
    bar.hidden = false
    $("#guidance-text").text(text)
    const $buttons = $("#guidance-buttons").empty()
    buttons.forEach((button) => {
        const $btn = $(`<button>${button.label}</button>`)
        $btn.on("click", () => {
            mainProcess.execAction(button.action, button.arg)
            bar.hidden = true
        })
        $buttons.append($btn)
    })
}

// 追加事件摘要
const EVENT_MAX = 30
function appendEvent(type, text) {
    const bar = document.getElementById("event-bar")
    const time = new Date()
    const pad = (n) => (n < 10 ? `0${n}` : n)
    const line = document.createElement("div")
    line.className = `event-line event-${type}`
    line.textContent = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())} ${text}`
    bar.appendChild(line)
    while (bar.children.length > EVENT_MAX) {
        bar.removeChild(bar.firstChild)
    }
    bar.scrollTop = bar.scrollHeight
}

// 接收事件摘要, 更新事件条
mainProcess.onUpdateEvents((_event, value) => {
    appendEvent(value.type, value.text)
})

// 接收进度更新
mainProcess.onUpdateProgress((_event, value) => {
    const bar = document.getElementById("progress-bar")
    if (value.percent === null || value.percent === undefined) {
        bar.hidden = true
        $("#progress-fill").css("width", "0")
        return
    }
    bar.hidden = false
    $("#progress-fill").css("width", `${Math.min(100, Math.max(0, value.percent))}%`)
})

// 隐藏进度条
function hideProgress() {
    document.getElementById("progress-bar").hidden = true
    $("#progress-fill").css("width", "0")
}

// 更新配置时, 禁止选择设备
mainProcess.onSettingNFCConfig((_event, value) => {
    if (value === "start") {
        isConnectingDevice = true
        $(".selection").css("background-color", "#b6b239")
    } else if (value === "success") {
        isConnectingDevice = false
        $(".selection").css("background-color", "#54ad6c")
    } else {
        isConnectingDevice = false
        $(".selection").css("background-color", "#cf4152")
    }
})

// 接收设备连接状态, 更新状态条
mainProcess.onUpdateDeviceStatus((_event, value) => {
    const indicator = $("#device-status-indicator")
    const text = $("#device-status-text")
    switch (value.state) {
        case "connecting":
            indicator.css("background-color", "#b6b239")
            text.html(i18n("html_device_connecting"))
            break
        case "connected":
            indicator.css("background-color", "#54ad6c")
            text.html(`${i18n("html_device_connected")} ${value.device}`)
            break
        case "failed":
            indicator.css("background-color", "#cf4152")
            text.html(i18n("html_device_failed"))
            break
        default:
            indicator.css("background-color", "var(--color-disabled-fg)")
            text.html(i18n("html_no_device"))
    }
})


// 显示选择设备下拉列表
function showDropdown(obj, e, action){
    e.stopPropagation(); //阻止冒泡
    //阻止默认浏览器动作(W3C)
    if ( e && e.preventDefault ){
        e.preventDefault();
    } else{
        window.event.returnValue = false;
    }
    const dropdownMenus = $(obj).next()
    if (dropdownMenus.is(":visible")) {
        dropdownMenus.hide();
    }else{
        $('.dropdown-menus').hide()
        if (action) action()
        $(obj).next().show();
    }
}

// 选择下拉列表设备
function selectedValue(obj, e){
    e.stopPropagation(); //阻止冒泡
    let selectedDom;
    // 点击的地方可能是li，也可能是li的子节点
    if(e.target && e.target.nodeName === "LI"){
        selectedDom = e.target;
    }else{
        selectedDom = $(e.target).parent();
    }

    const selectedValue = $(selectedDom).data('value');
    const selectedLabel = $(selectedDom).data('label');
    const operationID = $(obj).data('id');

    $(selectedDom).siblings().removeClass('ec-active')
    $(selectedDom).addClass('ec-active');
    $('#'+operationID+'-label').val(selectedLabel);
    $('#'+operationID+'-value').val(selectedValue);
    $(obj).parent().hide();
    mainProcess.execAction('conn-usb-devices', selectedValue)
}

// 点击其他位置关闭下拉列表
document.addEventListener("click", () => {
    if ($(".dropdown-menus").is(":visible")) {
        $('.dropdown-menus').hide();
    }
});

// 重置状态
function resetStatus(fromMain=false) {
    if (isTimerRunning || fromMain) {
        clearInterval(intervalID)
        isTimerRunning = false
        timerSecond = 0
    } else {
        $("#timer-value").html("")
        $statusText.html(i18n("indicator_free"))
        $statusText.prop("title", i18n("indicator_free"))
        $("#status-indicator").css("background-color", "transparent")
    }
}