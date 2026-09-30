const {exec, killProcess, printExitLog, printLog, printStatus} = require("./execUtils")
const fs = require('fs')
const {dialog, app, shell} = require('electron')
const cp = require("child_process");
const status = require("./status")
const { SerialPort } = require('serialport')
const path = require("path")
const { i18n } = require('./i18n')
const { createKeyInfoParser } = require('./keyParser')

const {
    createDumpHistoryWindow,
    createDumpComparatorWindow,
    createDumpEditorWindow,
    createInputKeysWindow,
    createHardNestedWindow,
    createDictTestWindow,
    createSettingsWindow,
    createAboutWindow,

    sendToMainWindow,
    sentToDictTestWindow,
    sentToDumpEditorWindow,
    sentToDumpComparatorWindow,
    sentToDumpHistoryWindow
} = require("./windows")

const userDataPath = app.getPath('userData')

const knownKeysFile = path.join(userDataPath, "./keys.txt")
const tempMFDFilePath = path.join(userDataPath, "./temp.mfd")
const dumpFilesPath = path.join(userDataPath, "./dumpfiles")
const noncesFilesPath = path.join(userDataPath, "./nonces.bin")
const nfcConfigFilePath = path.join(userDataPath, "./libnfc.conf")
let dictPath = app.isPackaged ?
    path.join(process.resourcesPath, "./dict.dic") :
    path.join(__dirname, "../dict.dic")
const dumpsFolder = path.join(userDataPath, "./dumpfiles")

let newKeys = []
let knownKeyInfo = []
let unknownKeyInfo = []
let keyInfoParser = createKeyInfoParser()
let totalUnknownKeys = 0
let mfocStartTime = 0
let mfocKeysDone = 0
let mfocKeysTotal = 0
let mfocLastUpdate = 0
let mfocPendingLine = ""
let mfocEtaFinished = false

const defaultKeys = [
    "ffffffffffff",
    "a0a1a2a3a4a5",
    "d3f7d3f7d3f7",
    "000000000000",
    "b0b1b2b3b4b5",
    "4d3a99c351dd",
    "1a982c7e459a",
    "aabbccddeeff",
    "714c5c886e97",
    "587ee5f9350f",
    "a0478cc39091",
    "533cb6c723f6",
    "8fd0a4f256e9"
]

const actions = {
    // 打开设置窗口
    "open-settings-window": createSettingsWindow,

    // 扫描设备
    "scan-usb-devices": () => {
        SerialPort.list().then(ports => {
            const devices = []
            ports.forEach(port => {
                devices.push(port["path"])
            })
            sendToMainWindow("update-usb-devices", devices)
        });
    },

    // 连接设备
    "conn-usb-devices": (device) => {
        if (device === " ") {
            status.currentDevice = null
            sendToMainWindow("update-device-status", {state: "none"})
            return
        }
        printStatus(i18n("indicator_connecting_device"))
        status.currentDevice = device
        sendToMainWindow("update-device-status", {state: "connecting", device})
        setNFCConfig()
    },

    // 速度设置
    // "set-speed": (speed) => {
    //     if (status.currentDevice === null) {dialog.showErrorBox("错误", "请先选择设备"); return}
    //     status.currentSpeed = speed
    //     setNFCConfig()
    // },

    // 一键解卡
    "read-IC": () => {
        printStatus(i18n("indicator_reading_ic_card"))
        mfoc([`-O${tempMFDFilePath}`, `-f${knownKeysFile}`])
    },

    // 一键写卡
    "write-IC": (dumpId) => {
        const startWrite = (mfdFilePath) => {
            dialog.showMessageBox({
                type: "warning",
                buttons: [i18n("dialog_button_cancel"), i18n("dialog_button_ok")],
                title: i18n("dialog_title_danger_operation"),
                message: i18n("dialog_msg_confirm_write_dump")
            }).then((response) => {
                if (response.response !== 1) return
                readICThenExec(
                    i18n("log_msg_start_write_card"), i18n("indicator_writing_ic_card"), true,
                    "nfc-mfclassic", ["w", "A", "u", mfdFilePath, tempMFDFilePath, "f"],
                    (code) => {
                        printLog(`\n\n${code === 0 ? i18n("log_msg_write_success") : i18n("log_msg_write_failed")}\n`)
                    }
                )
            })
        }

        if (dumpId) {
            startWrite(path.isAbsolute(dumpId) ? dumpId : path.join(dumpsFolder, dumpId))
            return
        }
        dialog.showOpenDialog({
            title: i18n("dialog_title_choose_dump_need_to_write"),
            defaultPath: dumpFilesPath,
            buttonLabel: i18n("dialog_button_open"),
            filters: [{ name: i18n("file_type_dump"), extensions: ['dump', 'mfd'] }],
            message: i18n("dialog_msg_choose_dump_file")
        }).then(result => {
            if (result["canceled"] === true) return
            startWrite(result["filePaths"][0])
        })
    },

    // 格式化
    "format-card": () => {
        readICThenExec(
            i18n("log_msg_start_format_card"), i18n("indicator_formatting_ic_card"), true,
            "nfc-mfclassic", ["f", "A", "u", tempMFDFilePath, tempMFDFilePath, "f"]
        )
    },

    // 输入已知密钥解卡
    "input-keys-read-IC": () => {createInputKeysWindow("done-input-keys-read-IC")},
    "done-input-keys-read-IC": (keys) => {
        const keyArg = []
        // 输入框被清空或内容不含 12 位 hex 时 match 返回 null, 直接 forEach 会抛异常
        ;(keys.match(/[0-9A-Fa-f]{12}/g) || []).forEach(key => {
            keyArg.push(`-k${key}`)
        })
        printStatus(i18n("indicator_reading_ic_card"))
        mfoc(keyArg.concat([`-O${tempMFDFilePath}`, `-f${knownKeysFile}`]))
    },

    // 检测卡片类型
    "detect-card-type": () => {
        checkKeyFileExist()
        resetKeyInfo()
        printStatus(i18n("indicator_detecting_ic_card"))
        exec(
            i18n("log_msg_start_detect_card"),
            'nfc-mfdetect', [`-N`, `-f${knownKeysFile}`],
            (value) => {keyInfoStatistic(value)},
        ).then(()=>{
            printExitLog(0)
            if (unknownKeyInfo.length > 0) {
                sendToMainWindow("show-guidance", {
                    text: `${i18n("guidance_unknown_pre")}${unknownKeyInfo.length}${i18n("guidance_unknown_post")}`,
                    buttons: [
                        {action: "hard-nested", label: i18n("html_hard_nested")},
                        {action: "dict-test", label: i18n("html_test_dictionary")}
                    ]
                })
            }
        }).catch(() => {})
    },

    // 写 UFUID UID
    "write-ufuid-uid": () => {
        dialog.showOpenDialog({
            title: i18n("dialog_title_choose_dump_need_to_write"),
            defaultPath: dumpFilesPath,
            buttonLabel: i18n("dialog_button_open"),
            filters: [{ name: i18n("file_type_dump"), extensions: ['dump', 'mfd'] }],
            message: i18n("dialog_msg_choose_dump_file")
        }).then(result => {
            if (result["canceled"] === true) return
            let block0Hex
            try {
                block0Hex = fs.readFileSync(result["filePaths"][0]).subarray(0, 16).toString("hex").toUpperCase()
            } catch (e) {
                printLog(`\n\n${i18n("log_msg_read_dump_file_failed")}\n`)
                printExitLog(1)
                return
            }
            if (block0Hex.length !== 32) {
                printLog(`\n\n${i18n("log_msg_dump_file_too_short")}\n`)
                printExitLog(1)
                return
            }
            dialog.showMessageBox({
                type: "warning",
                buttons: [i18n("dialog_button_cancel"), i18n("dialog_button_ok")],
                title: i18n("dialog_title_danger_operation"),
                message: `${i18n("dialog_msg_confirm_write_uid")}${block0Hex}`
            }).then((response) => {
                if (response.response === 1) {
                    printStatus(i18n("indicator_writing_ufuid_uid"))
                    exec(i18n("log_msg_start_write_ufuid_uid"), "nfc-mfsetuid", ["-q", block0Hex]).then(()=>{printExitLog(0)}).catch(() => {})
                }
            })
        })
    },

    // 锁 UFUID
    "lock-ufuid": () => {
        dialog.showMessageBox({
            type: "warning",
            buttons: [i18n("dialog_button_cancel"), i18n("dialog_button_ok")],
            title: i18n("dialog_title_danger_operation"),
            message: i18n("dialog_msg_card_will_be_locked"),
        }).then((response) => {
            if (response.response === 1) {
                printStatus(i18n("indicator_locking_ufuid"))
                exec(i18n("log_msg_start_lock_ufuid"), "nfc-mflock", ["-q"]).then(()=>{printExitLog(0)}).catch(() => {})
            }
        })
    },

    // HardNested 解密
    "hard-nested": () => {
        try {createHardNestedWindow({
            knownKey: knownKeyInfo[0][0],
            knownSector: knownKeyInfo[0][1],
            knownKeyType: knownKeyInfo[0][2],
            targetSector: unknownKeyInfo[0][0],
            targetKeyType: unknownKeyInfo[0][1]
        })}
        catch (e) {createHardNestedWindow()}},
    "hard-nested-config-done": (configs) => {
        if (configs.autoRun) {
            fs.writeFileSync(noncesFilesPath, '');
            readICThenExec(i18n("lod_msg_start_auto_hard_nested"),
                `${i18n("indicator_doing_hard_nested")} - ${totalUnknownKeys - unknownKeyInfo.length + 1}/${totalUnknownKeys}`,
                false,
                () => {
                    if (configs.fromUser) totalUnknownKeys = unknownKeyInfo.length

                    if (knownKeyInfo.length === 0) {
                        printLog(`\n${i18n("log_msg_not_found_known_key")}`);
                        printExitLog(1);
                        return;
                    }
                    if (unknownKeyInfo.length === 0) {
                        printLog(`\n${i18n("log_msg_tried_decrypt_all_unknown_keys")}\n`);
                        printExitLog(0);
                        return;
                    }
                    configs.knownKey = knownKeyInfo[0][0]
                    configs.knownSector = knownKeyInfo[0][1]
                    configs.knownKeyType = knownKeyInfo[0][2]
                    configs.targetSector = unknownKeyInfo[0][0]
                    configs.targetKeyType = unknownKeyInfo[0][1]
                    execAction("run-hard-nested", configs)
                })
        }
        else execAction("run-hard-nested", configs)
    },
    "run-hard-nested": (configs) => {
        let uid, sector, keyType
        configs.knownSector = (parseInt(configs.knownSector) + 1) * 4 - 1
        configs.targetSector = (parseInt(configs.targetSector) + 1) * 4 - 1
        if (!configs.autoRun) totalUnknownKeys = unknownKeyInfo.length

        sendHardNestedProgress()
        printStatus(`${i18n("indicator_collecting_nonces")}${configs.autoRun ? ` - ${totalUnknownKeys - unknownKeyInfo.length + 1}/${totalUnknownKeys}` : ""}`)
        exec(
            `${i18n("log_msg_start_collect_nonces")}\n\n`,
            "libnfc-collect", [
                configs.knownKey,
                configs.knownSector,
                configs.knownKeyType,
                configs.targetSector,
                configs.targetKeyType,
                "bin",
                noncesFilesPath
            ],
            (value) => {
                let i = value.indexOf("Found tag with uid ")
                if (i >= 0) {
                    uid = value.substring(i + 19, i + 27)
                    i = value.indexOf("collecting nonces for key")
                    if (i >= 0) {
                        const pattern = /\(sector (\d{1,2})\)/;
                        const match = pattern.exec(value);
                        // 必须是数字, unknownKeyInfo 里的扇区号是 parseInt 出来的, 用字符串比永远不相等
                        if (match) sector = parseInt(match[1])
                        keyType = value.substring(i + 26, i + 27)
                    }
                }
            },
            () => {
                if (configs.collectOnly && fs.statSync(noncesFilesPath).size !== 0) {
                    const url = dialog.showSaveDialogSync({
                        title: i18n("dialog_title_save_to"),
                        defaultPath: uid ? `${uid}_${sector}${keyType}` : "nonces",
                        filters: [{ name: i18n("file_type_bin"), extensions: ['bin'] }],
                        message: i18n("dialog_msg_choose_save_path")
                    })
                    if (!url) {
                        printLog(i18n("log_msg_not_saved"))
                    } else {
                        fs.rename(noncesFilesPath, url, (err) => {
                            if (err) {
                                reportIOError(err)
                            }
                            else {
                                printLog(  `\n\n${i18n("log_msg_file_already_saved_to")} ${url}\n`)
                                printExitLog(0)
                            }
                        })
                    }
                }
            }).then(() => {
                if (!configs.collectOnly)  {
                    sendHardNestedProgress()
                    printStatus(`${i18n("indicator_doing_hard_nested")} - ${totalUnknownKeys - unknownKeyInfo.length + 1}/${totalUnknownKeys}`)
                    let foundKey = false
                    exec(
                        i18n("lod_msg_start_hard_nested"),
                        "cropto1_bs", [noncesFilesPath],
                        (value) => {
                            let i = value.indexOf("Key found:")
                            if (i >= 0) {
                                i += 11
                                const key = value.substring(i, i + 12)
                                if (!key) return
                                foundKey = true
                                saveKeys([key])
                                if (unknownKeyInfo.length === 0) return
                                if (unknownKeyInfo[0][0] === sector && unknownKeyInfo[0][1] === keyType) unknownKeyInfo.shift()
                            }
                        }).then(() => {
                            if (configs.autoRun) {
                                // 一轮下来没解出任何密钥时继续递归只是反复采集同一批 nonce, 空转占用读卡器
                                if (!foundKey) {
                                    printLog(`\n${i18n("log_msg_no_hard_nested_progress")}\n`)
                                    printExitLog(0)
                                    return
                                }
                                execAction("hard-nested-config-done", {
                                    knownKey: knownKeyInfo[0][0],
                                    knownSector: knownKeyInfo[0][1],
                                    knownKeyType: knownKeyInfo[0][2],
                                    targetSector: unknownKeyInfo[0][0],
                                    targetKeyType: unknownKeyInfo[0][1],
                                    collectOnly: false,
                                    autoRun: true
                                })
                            } else {printExitLog(0)}
                        }).catch(() => {})
                }
            }).catch(() => {})
    },

    //打开字典文件
    "open-dict-file": () => {
        const url = dialog.showOpenDialogSync({
            title: i18n("dialog_title_choose_dictionary_file"),
            defaultPath: dictPath,
            filters: [{ name: i18n("file_type_dict"), extensions: ['txt', 'dic'] }],
            message: i18n("dialog_msg_choose_dictionary_file"),
            properties: ['openFile']
        })
        if (url) {
            dictPath = url[0]
            const pathArray = dictPath.split(/[\/\\]/g)
            sentToDictTestWindow("dict-file-name", pathArray[pathArray.length - 1])
        }
    },
    // 字典测试
    "dict-test": () => {
        try {
            createDictTestWindow({
                targetSector: unknownKeyInfo[0][0],
                targetKeyType: unknownKeyInfo[0][1]
            })
        }
        catch (e) {createDictTestWindow()}
    },
    "dict-test-config-done": (configs) => {
        printStatus(i18n("indicator_testing_dictionary"))
        exec(i18n("log_msg_start_test_dictionary"),
            "nfc-mfdict", [`-s${configs.sector}`, `-t${configs.keyType}`, `-l${configs.startPosition}`, `-d${dictPath}`],
            (value) => {
                let i = value.indexOf("Found Key: ")
                if (i >= 0) {
                    i += 11
                    const key = value.substring(i, i + 12)
                    saveKeys([key])
                    if (unknownKeyInfo.length === 0) return
                    if (unknownKeyInfo[0][0] === configs.sector && unknownKeyInfo[0][1] === configs.keyType) unknownKeyInfo.shift()
                }
            }
        ).then(()=>{printExitLog(0)}).catch(() => {})
    },

    // 打开历史密钥
    "open-history-keys": () => {cp.exec(`${process.platform === "win32" ? "notepad.exe" : "open"} "${knownKeysFile}"`)},

    // 转储编辑器
    "open-dump-editor": (file) => {
        createDumpEditorWindow(file ? path.join(dumpsFolder, file) : null)
    },
    "dump-editor-choose-file": (filePath) => {
        const filePaths = filePath ? filePath : dialog.showOpenDialogSync({
            title: i18n("dialog_title_choose_dump_file"),
            defaultPath: dictPath,
            properties: ['openFile'],
            filters: [{ name: 'Dump Files', extensions: ['mfd', 'dump'] }],
            message: i18n("dialog_msg_choose_dump_file"),
        })[0]
        fs.readFile(filePaths, (err, data) => {
            if (err) {reportIOError(err); return}
            const hexDataArray = Array.from(new Uint8Array(data), function(byte) {
                return ('0' + (byte & 0xff).toString(16)).slice(-2);
            }).join('').match(/.{1,32}/g);
            const groupedHexData = [];
            for (let i = 0; i < hexDataArray.length; i += 4) {
                groupedHexData.push((hexDataArray.slice(i, i + 4)).join('\n'));
            }
            sentToDumpEditorWindow('binary-data', {url: filePaths, data: groupedHexData});
        });
    },
    "dump-editor-save": (data) => {
        const binaryArray = new Buffer.from(data.hexData, "hex")

        const save = (url) => {
            fs.writeFile(url, binaryArray, (error) => {
                if (error) {
                    reportIOError(error)
                } else {
                    sentToDumpEditorWindow('saved-binary-data', {url})
                }
            })
        }

        if (data.saveAs) {
            const url = dialog.showSaveDialogSync({
                title: i18n("dialog_title_save_to"),
                defaultPath: data.url,
                filters: [{ name: i18n("file_type_dump"), extensions: ['dump', 'mfd'] }],
                message: i18n("dialog_msg_choose_save_path")
            })
            if (url) save(url)
        } else save(data.url)
    },

    // 转储比较器
    "open-dump-comparator": (dumpFilesData) => {
        // dumpFilesData = {A: "dump1.mfd", B: "dump2.mfd"}
        if (dumpFilesData) {
            dumpFilesData.A = path.join(dumpsFolder, dumpFilesData.A);
            dumpFilesData.B = path.join(dumpsFolder, dumpFilesData.B)
        }
        createDumpComparatorWindow(dumpFilesData)
    },
    "dump-comparator-choose-file": (type) => {
        const dumpType = type.type
        const filePaths = type.path ? type.path : dialog.showOpenDialogSync({
            title: i18n("dialog_title_choose_dump_file"),
            defaultPath: dictPath,
            properties: ['openFile'],
            filters: [{ name: 'Dump Files', extensions: ['mfd', 'dump'] }],
            message: i18n("dialog_msg_choose_dump_file"),
        })[0]
        fs.readFile(filePaths, (err, data) => {
            if (err) {reportIOError(err); return}
            const hexDataArray = Array.from(new Uint8Array(data), function(byte) {
                return ('0' + (byte & 0xff).toString(16)).slice(-2);
            }).join('').match(/.{1,32}/g);
            const groupedHexData = [];
            for (let i = 0; i < hexDataArray.length; i += 4) {
                groupedHexData.push(hexDataArray.slice(i, i + 4));
            }
            sentToDumpComparatorWindow('binary-data', {url: filePaths, data: groupedHexData, type: dumpType});
        });
    },

    // 打开转储目录
    "open-dump-folder": () => {
        fs.mkdir(dumpsFolder, {recursive: true}, () => {
            shell.openPath(dumpsFolder)
        })
    },

    // 历史记录
    "dump-history": () => {
        fs.mkdir(dumpsFolder, () => {
            const dumpFiles = fs.readdirSync(dumpsFolder).filter(file => file.endsWith('.mfd'));
            createDumpHistoryWindow(dumpFiles)
        });
    },
    // 删除历史记录
    "delete-dump": (files) => {
        // 弹出确认框
        const confirmDelete = dialog.showMessageBoxSync({
            type: 'question',
            buttons: [i18n("dialog_button_ok"), i18n("dialog_button_cancel")],
            message: i18n("dialog_msg_are_you_sure_to_delete_these_dumps"),
            detail: files.join('\n'),
        });

        if (confirmDelete === 0) { // 用户点击 Yes
            files.forEach((file) => {
                fs.unlink(path.join(dumpsFolder, file), (err) => {
                    if (err) {reportIOError(err); return}
                    updateDumpFiles()
                });
            });
        }
    },
    // 重命名
    "rename-dump-file": (fileObj) => {
        const { oldName, newName } = fileObj;
        fs.rename(path.join(dumpsFolder, oldName), path.join(dumpsFolder, newName), (err) => {
            if (err) {reportIOError(err); return}
            updateDumpFiles()
        });
    },

    // 取消任务
    "cancel-task": () => {
        killProcess()
    },

    // 保存日志
    "save-log": (content) => {
        const url = dialog.showSaveDialogSync({
            title: i18n("dialog_title_save_to"),
            defaultPath: `NFCTools_log_${getTimeList().join("_")}`,
            filters: [{ name: i18n("file_type_txt"), extensions: ['txt'] }],
            message: i18n("dialog_msg_choose_save_path")
        })

        if (!url) {
            printLog(i18n("log_msg_not_saved"))
        } else {
            fs.writeFile(url, content, (err) => {
                if (err) {
                    reportIOError(err)
                }
                else {
                    printLog(`\n\n${i18n("log_msg_file_already_saved_to")} ${url}\n`)
                    printExitLog(0)
                }
            })
        }
    },
    // about page
    "open-about": createAboutWindow
}

// 异步回调里 throw 会被 Node 当作 uncaughtException 直接终止主进程, 连带丢掉用户
// 正在编辑的 dump 和正在跑的日志。所有 fs 回调的错误都走这里, 改成写日志。
function reportIOError(err) {
    console.error(err)
    printLog(`\n${i18n("log_msg_operation_failed")} ${err && err.message ? err.message : String(err)}\n`)
    printExitLog(1)
}

// 保存密钥
function saveKeys(keys) {
    const knownKeys = fs.readFileSync(knownKeysFile).toString().match(/[0-9A-Fa-f]{12}/g)
    const knownSet = knownKeys ? new Set(knownKeys) : new Set()
    keys = Array.from(new Set(knownKeys ? knownKeys.concat(keys) : keys))
    defaultKeys.forEach((value) => {
        let i = keys.indexOf(value)
        if (i >= 0) keys.splice(i, 1)
    })
    fs.writeFileSync(knownKeysFile, `${keys.join("\n")}`)
    const fresh = keys.filter((key) => !knownSet.has(key))
    if (fresh.length > 0) {
        sendToMainWindow("update-events", {type: "key", text: `${i18n("event_keys_saved")}${fresh.join(", ")}`})
    }
}

// 先读卡，然后进行后续操作
function readICThenExec(msg, statusMsg, isSaveDumpFile, cmd, args, processHandler, finishHandler) {
    let isCmdFunc = true
    if (arguments.length === 4) isCmdFunc = false
    checkKeyFileExist()
    resetKeyInfo()
    printStatus(isSaveDumpFile ? i18n("indicator_backing_up_current_card") : i18n("indicator_detecting_ic_card"))
    exec(
        i18n("log_msg_read_ic_then_execute"),
        'nfc-mfdetect', isSaveDumpFile ? [`-O${tempMFDFilePath}`, `-f${knownKeysFile}`] : [`-N`, `-f${knownKeysFile}`],
        (value) => {keyInfoStatistic(value)},
        () => {
            saveKeys(newKeys)
            if (isSaveDumpFile && fs.existsSync(tempMFDFilePath) && fs.statSync(tempMFDFilePath).size === 0) {
                fs.unlinkSync(tempMFDFilePath)
            }
        }).then(() => {
            printStatus(statusMsg)
            if (!isCmdFunc) {cmd(); return;}
            if (isSaveDumpFile && !fs.existsSync(tempMFDFilePath)) {
                printLog(`\n${i18n("log_msg_card_read_failed")}\n`)
                printExitLog(0)
                return
            }
            exec(msg, cmd, args, processHandler, (code, signal)=>{
                if (finishHandler) finishHandler(code, signal)
                fs.unlink(tempMFDFilePath, (err) => {
                    if (err) console.error(err)
                })
            }).then(()=>{printExitLog(0)}).catch(() => {})
        }).catch(() => {})
}

// 执行MFOC解密
function mfoc(args) {
    let cardID = null
    resetKeyInfo()
    checkKeyFileExist()

    // 预估剩余时长: 字典攻击总轮数 = 内置默认密钥 + 密钥文件密钥 + -k 密钥
    mfocStartTime = Date.now()
    mfocKeysDone = 0
    mfocLastUpdate = 0
    mfocPendingLine = ""
    mfocEtaFinished = false
    const fileKeys = fs.readFileSync(knownKeysFile).toString().match(/[0-9A-Fa-f]{12}/g) || []
    const argKeys = args.filter((arg) => arg.startsWith("-k"))
    mfocKeysTotal = defaultKeys.length + fileKeys.length + argKeys.length

    exec(
        i18n("log_msg_start_mfoc"),
        'mfoc', args,
        (value) => {
            keyInfoStatistic(value)
            updateMfocETA(value)

            let i = value.indexOf("UID (NFCID1):")
            if (i >= 0) {
                i += 14
                cardID = value.substring(i, i + 14).replace(/\s+/g, "")
            }
        },
        () => {
            saveKeys(newKeys)
            if (!fs.existsSync(tempMFDFilePath)) {
                printLog(`\n${i18n("log_msg_dump_empty_not_saved")}\n`)
                return
            }
            if (fs.statSync(tempMFDFilePath).size === 0) {
                fs.unlink(tempMFDFilePath, (err) => {
                    if (err) console.error(err)
                })
                printLog(`\n${i18n("log_msg_dump_empty_not_saved")}\n`)
                return
            }
            fs.mkdir(dumpsFolder, () => {
                const defaultName = `${cardID || "card"}_${getTimeList().join("_")}.mfd`
                const url = dialog.showSaveDialogSync({
                    title: i18n("dialog_title_save_to"),
                    defaultPath: path.join(dumpsFolder, defaultName),
                    filters: [{ name: i18n("file_type_dump"), extensions: ['dump', 'mfd'] }],
                    message: i18n("dialog_msg_choose_save_path")
                })
                const target = url || path.join(dumpsFolder, defaultName)
                fs.rename(tempMFDFilePath, target, (err) => {
                    if (err) {
                        printLog(`\n\n${i18n("log_msh_save_failed")}\n`)
                        printExitLog(1)
                        return
                    }
                    if (url) printLog(`\n\n${i18n("log_msg_file_already_saved_to")} ${url}\n`)
                    else printLog(`\n\n${i18n("log_msg_dump_auto_saved")} ${target}\n`)
                    sendToMainWindow("dump-saved", {filename: target})
                })
            })
        }
    ).then(()=>{printExitLog(0)}).catch(() => {})
}

// 按字典攻击实测速度预估 mfoc 剩余时长
function updateMfocETA(value) {
    if (mfocEtaFinished) return
    mfocPendingLine += value
    const newlineIndex = mfocPendingLine.lastIndexOf("\n")
    if (newlineIndex < 0) return
    const complete = mfocPendingLine.slice(0, newlineIndex)
    mfocPendingLine = mfocPendingLine.slice(newlineIndex + 1)
    mfocKeysDone += (complete.match(/\[Key: /g) || []).length
    if (mfocKeysDone === 0) return

    if (mfocKeysDone >= mfocKeysTotal) {
        mfocEtaFinished = true
        printStatus(i18n("indicator_reading_ic_card"))
        sendToMainWindow("update-progress", {percent: 100})
        return
    }

    const now = Date.now()
    if (now - mfocLastUpdate < 1000) return
    mfocLastUpdate = now
    const remainSec = Math.round((now - mfocStartTime) / 1000 / mfocKeysDone * (mfocKeysTotal - mfocKeysDone))
    printStatus(`${i18n("indicator_reading_ic_card")} - ${i18n("html_eta_remaining")} ${formatDuration(remainSec)}`)
    sendToMainWindow("update-progress", {percent: Math.round(mfocKeysDone / mfocKeysTotal * 100)})
}

// 发送 HardNested 自动执行的进度
function sendHardNestedProgress() {
    if (!totalUnknownKeys) return
    const index = Math.max(1, totalUnknownKeys - unknownKeyInfo.length + 1)
    sendToMainWindow("update-progress", {percent: Math.min(100, Math.round(index / totalUnknownKeys * 100))})
}

// 格式化时长为 hh:mm:ss / mm:ss
function formatDuration(sec) {
    const double = (num) => num < 10 ? `0${num}` : `${num}`
    const h = Math.floor(sec / 3600)
    const m = Math.floor(sec / 60) % 60
    const s = sec % 60
    return h > 0 ? `${double(h)}:${double(m)}:${double(s)}` : `${double(m)}:${double(s)}`
}

// 统计密钥信息
// stdout 分块边界与扇区边界无关, 因此解析器按行缓冲并直接捕获工具打印的扇区号,
// 不能用匹配序号反推 —— 详见 src/keyParser.js 与 test/parse/keyParser.test.js
function resetKeyInfo() {
    keyInfoParser = createKeyInfoParser()
    newKeys = []
    knownKeyInfo = []
    unknownKeyInfo = []
}

function keyInfoStatistic(content) {
    for (const record of keyInfoParser.push(content)) {
        if (record.key === null) {
            unknownKeyInfo.push([record.sector, record.type])
        } else {
            knownKeyInfo.push([record.key, record.sector, record.type])
            newKeys.push(record.key)
        }
    }
}

// 检查密钥文件是否存在
function checkKeyFileExist() {
    if (!fs.existsSync(knownKeysFile)) fs.writeFileSync(knownKeysFile, "")
}

// 配置 libnfc.conf
function setNFCConfig() {
    sendToMainWindow("setting-nfc-config", "start")
    const content = `device.name = "NFC_Device"\ndevice.connstring = "pn532_uart:${status.currentDevice}:${status.currentSpeed}"`
    // 无论成功、被拒绝还是被中断, 都要把"正在配置"状态收尾, 否则渲染端的下拉框会一直禁用
    let settled = false
    const settle = () => {
        if (settled) return
        settled = true
        const connected = status.isDeviceConnected
        sendToMainWindow("setting-nfc-config", connected ? "success" : "failed")
        sendToMainWindow("update-device-status", {
            state: connected ? "connected" : "failed",
            device: status.currentDevice
        })
    }
    fs.writeFile(nfcConfigFilePath, content, (err) => {
        if (err) {
            printLog(`\n${err.message}\n`)
            status.isDeviceConnected = false
            settle()
            return
        }
        exec(i18n("log_msg_start_connect_device"),
            "nfc-list", [],
            (value) => {
                if (value.indexOf("NFC device: NFC_Device opened") >= 0) {
                    printLog(`\n*** ${i18n("log_msg_discover_device")} ***\n`)
                    status.isDeviceConnected = true
                }
                if (value.indexOf("Unable to open NFC device") >= 0) {
                    printLog(`\n*** ${i18n("log_msg_not_found_device")} ***\n`)
                    status.isDeviceConnected = false
                }
            },
            settle,
        ).then(()=>{printExitLog(0)}).catch(() => {settle()})
    })
}

function getTimeList() {
    const date = new Date()
    const time = [
        date.getFullYear(),
        date.getMonth() + 1,
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds()
    ]
    time.forEach((value, index) => {
        if (value < 10) time[index] = `0${value}`
        else time[index] = `${value}`
    })
    return time
}

function updateDumpFiles() {
    const dumpFiles = fs.readdirSync(dumpsFolder).filter(file => file.endsWith('.mfd'));
    sentToDumpHistoryWindow('update-dump-history', dumpFiles)
}

function execAction(action, arg) {
    actions[action](arg)
}
module.exports = {execAction}