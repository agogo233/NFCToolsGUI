// 设备列表的比较键。扫描结果是对象数组 {path, vendorId}, 但 Electron 端口与 UI 测试桩
// 仍会给字符串数组, 两种形态都要支持。对象不能用引用比较 (每次 emit 都是全新反序列化的
// 对象字面量), 必须按键值比较, 否则去重永远失效, 下拉列表会被反复重建、高亮被抹掉。
const deviceKeyOf = (v) => (typeof v === "string" ? v : `${v.path}#${v.vendorId}`)

// 比较两个 List
function isListEqual(a, b) {
    if (a.length !== b.length) {
        return false
    } else {
        for (let i = 0; i < a.length; i++) {
            if (deviceKeyOf(a[i]) !== deviceKeyOf(b[i])) {
                return false
            }
        }
        return true;
    }
}

function getRatioValue(name){
    const radio = document.getElementsByName(name);
    for (let i = 0; i < radio.length; i++) {
        if (radio[i].checked) {
            return radio[i].value
        }
    }
}

function setRatioValue(name, value){
    const radio = document.getElementsByName(name);
    for (let i = 0; i < radio.length; i++) {
        if (radio[i].value === value) {
            radio[i].checked = true
        }
    }
}