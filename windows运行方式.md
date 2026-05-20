# Windows 从零运行方式

本文说明如何在 Windows 系统上从零开始运行本项目，包括普通浏览器前端和可选的 Electron 透明桌面窗口。

## 1. 需要安装的软件

### Python

建议安装 Python 3.10 或 3.11。

下载地址：

```text
https://www.python.org/downloads/windows/
```

安装时请勾选：

```text
Add python.exe to PATH
```

安装完成后，打开 PowerShell 或命令提示符，确认可用：

```bat
python --version
pip --version
```

### Node.js

Electron 桌面窗口需要 Node.js。

建议安装 Node.js LTS 版本：

```text
https://nodejs.org/
```

安装完成后确认可用：

```bat
node --version
npm --version
```

### 麦克风权限

项目需要读取麦克风输入。请在 Windows 中确认麦克风权限已开启：

```text
设置 -> 隐私和安全性 -> 麦克风 -> 允许桌面应用访问麦克风
```

## 2. 准备项目目录

进入项目目录，例如：

```bat
cd C:\path\to\Smartta
```

后续命令都在项目根目录执行，也就是能看到 `main.py`、`requirements.txt`、`web`、`wanko` 的目录。

## 3. 安装 Python 依赖

创建虚拟环境：

```bat
python -m venv .venv
```

激活虚拟环境：

```bat
.venv\Scripts\activate
```

安装依赖：

```bat
pip install -r requirements.txt
```

项目会安装这些主要依赖：

- `vosk`：离线语音识别
- `sounddevice`：读取麦克风
- `rapidfuzz`：文本模糊匹配
- `aiohttp`：提供网页和 WebSocket 服务

## 4. 准备 Vosk 中文模型

项目默认读取：

```text
model\vosk-model-small-cn-0.22
```

如果还没有模型，请下载 Vosk 中文小模型，例如：

```text
vosk-model-small-cn-0.22
```

解压后目录结构应类似：

```text
Smartta\
  main.py
  model\
    vosk-model-small-cn-0.22\
      am\
      conf\
      graph\
      ivector\
      ...
```

如果模型放在其他位置，运行时可以用 `--model-path` 指定。

## 5. 准备问答库和答案音频

问答库文件是：

```text
qa_library.json
```

格式示例：

```json
[
  {
    "question": "你好",
    "answer_audio": "answers/hello.wav",
    "answer_text": "你好，我在这里。"
  }
]
```

请把答案音频放到对应路径，例如：

```text
Smartta\
  answers\
    hello.wav
```

注意：

- `question` 是用户说的话，用于模糊匹配。
- `answer_audio` 是前端要播放的语音文件路径。
- `answer_text` 是 Electron 字幕显示的文本；不填写时会用 `question` 兜底。
- 建议使用较短、清晰的 `wav` 音频。

## 6. 准备或替换 Live2D 模型

项目默认使用 `wanko` 文件夹中的模型：

```text
wanko\runtime\wanko_touch.model3.json
```

默认情况下无需额外配置，直接运行 `python main.py` 就会使用这个模型。

如果要替换成其他 Live2D Cubism 4 模型，请把模型运行时文件放在一个目录中，例如：

```text
Smartta\
  my_live2d_model\
    runtime\
      my_model.model3.json
      my_model.moc3
      textures\
      motion\
```

启动时指定模型目录：

```bat
python main.py --live2d-model-dir my_live2d_model\runtime
```

如果同一目录里有多个 `*.model3.json`，可以指定模型文件名：

```bat
python main.py --live2d-model-dir my_live2d_model\runtime --live2d-model-file my_model.model3.json
```

说明：

- `--live2d-model-dir` 指向包含 `*.model3.json` 的运行时目录。
- `--live2d-model-file` 只写文件名或相对路径，不要写到模型目录之外。
- 前端会自动从模型配置读取 LipSync 嘴型参数，用于播放语音时张嘴。

## 7. 运行后端服务

确认虚拟环境已激活：

```bat
.venv\Scripts\activate
```

启动项目：

```bat
python main.py
```

启动成功后，终端会显示类似：

```text
语音助手启动。按 Ctrl+C 退出。
开始监听麦克风...
前端地址: http://127.0.0.1:8765
```

## 8. 使用浏览器前端

打开浏览器访问：

```text
http://127.0.0.1:8765
```

浏览器会显示 Live2D 角色和连接状态。识别到匹配问题后，后端会通知前端播放答案语音，Live2D 会根据音量张嘴并切换动作。

## 9. 使用 Electron 透明桌面窗口

Electron 是可选实现方式。它会打开一个透明、置顶、默认鼠标穿透的桌面窗口，只显示 Live2D 角色。
播放答案语音时，窗口中下部会显示字幕，字幕来自 `qa_library.json` 的 `answer_text` 字段，并按音频时长粗略同步。

第一次使用前安装 Node 依赖：

```bat
npm install
```

保持 `python main.py` 正在运行，再打开另一个 PowerShell 或命令提示符，进入项目目录：

```bat
cd C:\path\to\Smartta
```

启动 Electron 桌面窗口：

```bat
npm run desktop
```

**如果 npm run desktop 指令报错**
### 设置淘宝镜像
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

### 删除现有的 electron 模块
rmdir /s /q node_modules\electron

### 重新安装
npm install electron --save-dev

Electron 快捷键：

- `Ctrl+Alt+D`：切换鼠标穿透 / 可拖动模式
- `Ctrl+Alt+方向键`：移动窗口位置
- `Ctrl+Alt++ / Ctrl+Alt+-`：放大或缩小窗口
- `Ctrl+Alt+Q`：退出 Electron 窗口

说明：

- 窗口默认鼠标穿透，点击会落到桌面或后面的窗口。
- 穿透模式下窗口无法接收鼠标拖动，这是系统行为。
- 需要移动角色位置时，按 `Ctrl+Alt+D` 切到可拖动模式，拖动完成后再按一次切回穿透。
- 切到可拖动模式后，右下角会出现缩放把手，可以拖动调整窗口大小。

如果后端端口不是默认的 `8765`，可以这样启动：

```bat
npm run electron -- --server-url=http://127.0.0.1:9000
```

## 10. 常用启动参数

默认启动：

```bat
python main.py
```

指定识别阈值、采样率、端口：

```bat
python main.py --threshold 40 --samplerate 16000 --blocksize 4000 --host 127.0.0.1 --port 8765
```

指定 Vosk 模型路径：

```bat
python main.py --model-path model\vosk-model-small-cn-0.22
```

指定 Live2D 模型目录：

```bat
python main.py --live2d-model-dir wanko\runtime
```

指定麦克风设备：

```bat
python main.py --device 1
```

## 11. 查看麦克风设备

如果电脑有多个麦克风，可以运行：

```bat
python -c "import sounddevice as sd; print(sd.query_devices())"
```

找到输入设备 ID 后，用 `--device` 指定：

```bat
python main.py --device 1
```

## 12. 常见问题

### pip install sounddevice 失败

请先升级 pip：

```bat
python -m pip install --upgrade pip
pip install -r requirements.txt
```

如果仍然失败，确认 Python 版本是 64 位的 3.10 或 3.11。

### 启动时报 Vosk 模型不存在

检查模型目录是否是：

```text
model\vosk-model-small-cn-0.22
```

也可以用 `--model-path` 指向实际模型目录。

### 浏览器或 Electron 没有显示 Live2D

当前前端会从 CDN 加载 `pixi.js`、`pixi-live2d-display` 和 Live2D Cubism Core。第一次运行需要联网。

如果依赖加载失败，前端会显示回退状态。请检查网络，或后续把这些前端依赖下载到本地再改成本地路径。

如果提示 Live2D 模型目录或模型文件不存在，请检查：

```text
wanko\runtime\wanko_touch.model3.json
```

或确认 `--live2d-model-dir` 指向了正确目录。

### Electron 窗口不是透明的

Windows 上透明窗口依赖显卡驱动和系统合成效果。可以尝试：

- 更新显卡驱动
- 不要用兼容模式运行 Electron
- 避免在远程桌面或部分录屏软件环境中测试透明窗口

### 听不到答案语音

检查：

- `qa_library.json` 中的 `answer_audio` 路径是否正确
- 音频文件是否存在
- Windows 默认输出设备音量是否正常
- 浏览器或 Electron 是否允许播放音频

## 13. 推荐启动顺序

每次运行建议按这个顺序：

```bat
cd C:\path\to\Smartta
.venv\Scripts\activate
python main.py
```

如果要用 Electron 桌面窗口，再打开第二个终端：

```bat
cd C:\path\to\Smartta
npm run desktop
```
