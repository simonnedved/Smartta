# 离线语音助手 + Live2D 显示层

这个项目实现了你需要的流程：

1. 从麦克风实时接收语音
2. 用 Vosk 离线识别成文字
3. 在本地问答库中做文本模糊匹配
4. 通知浏览器前端播放匹配到的答案语音
5. 前端 Live2D 虚拟形象根据音频音量驱动口型（失败时自动回退到说话动画）

适用环境：Windows 11，无独立 NVIDIA 显卡（CPU 可运行）。
后端不会播放音频，避免和前端重音。

## 1. 安装依赖

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## 2. 准备 Vosk 中文模型

建议使用小模型以获得较低延迟（如 `vosk-model-small-cn-0.22`）。

模型目录结构示例：

```text
project_root/
  main.py
  qa_library.json
  model/
    vosk-model-small-cn-0.22/
      am/
      conf/
      ...
```

默认参数会读取：`model/vosk-model-small-cn-0.22`

## 3. 准备问答库、答案音频和 Live2D 模型

编辑 `qa_library.json`，格式如下：

```json
[
  {
    "question": "你好",
    "answer_audio": "answers/hello.wav",
    "answer_text": "你好，我在这里。"
  }
]
```

- `question`: 需要匹配的问题文本
- `answer_audio`: 要播放的语音文件路径（建议 `wav`）
- `answer_text`: 可选，Electron 字幕显示的文本；不填写时会用 `question` 兜底

建议把所有答案语音放在 `answers/` 目录中。

Live2D 默认使用 `wanko` 文件夹中的模型：

```text
wanko/runtime/wanko_touch.model3.json
```

后端会把当前选中的 Live2D 模型目录映射为前端路径 `/live2d/`。

如需替换模型，把新的 Cubism 4 模型运行时文件放到一个目录中，目录内应包含 `*.model3.json`、`*.moc3`、贴图、动作等资源，例如：

```text
my_live2d_model/
  runtime/
    my_model.model3.json
    my_model.moc3
    textures/
    motion/
```

启动时指定模型目录：

```bash
python main.py --live2d-model-dir my_live2d_model/runtime
```

如果目录里有多个 `*.model3.json`，可以指定文件名：

```bash
python main.py --live2d-model-dir my_live2d_model/runtime --live2d-model-file my_model.model3.json
```

## 4. 运行

```bash
python main.py
```

启动后打开：

```text
http://127.0.0.1:8765
```

### 可选：Electron 透明桌面窗口

这个模式会复用同一个后端服务，在桌面上打开一个透明、置顶的 Live2D 窗口。窗口默认鼠标穿透，只显示角色和口型/动作，不显示浏览器状态栏。

先安装 Electron 依赖：

```bash
npm install
```

保持后端运行：

```bash
python main.py
```

再启动桌面窗口：

```bash
npm run desktop
```

快捷键：

- `Ctrl+Alt+D`：在鼠标穿透和可拖动模式之间切换。穿透时点击会落到桌面或后面的窗口；可拖动时可按住角色窗口移动位置。
- `Ctrl+Alt+方向键`：移动窗口位置。
- `Ctrl+Alt++ / Ctrl+Alt+-`：放大或缩小窗口。
- `Ctrl+Alt+Q`：退出 Electron 窗口。

如果后端端口不是默认的 `8765`，可以指定：

```bash
npm run electron -- --server-url=http://127.0.0.1:9000
```

常用参数：

```bash
python main.py --threshold 40 --samplerate 16000 --blocksize 4000 --host 127.0.0.1 --port 8765
```

- `--threshold`：匹配阈值（0-100），越高越严格
- `--samplerate`：麦克风采样率，默认 16000
- `--blocksize`：每次处理音频块大小，默认 4000（延迟与稳定性的折中）
- `--device`：指定输入设备 ID（多麦克风时有用）
- `--host / --port`：前端服务监听地址和端口
- `--live2d-model-dir`：Live2D 模型运行时目录，默认 `wanko/runtime`
- `--live2d-model-file`：指定目录中的 `*.model3.json` 文件名，默认自动选择第一个

## 5. 音频设备排查

如果需要查看输入设备 ID，可运行：

```bash
python -c "import sounddevice as sd; print(sd.query_devices())"
```

然后使用：

```bash
python main.py --device 1
```

## 6. 前后端协同行为

- 识别命中后，后端通过 WebSocket 向前端发送 `play_audio`。
- 前端回传 `audio_started` 后，后端暂停麦克风识别。
- 前端回传 `audio_finished` 后，后端恢复麦克风识别。
- 可避免“助手把自己回答识别成用户输入”的问题。
- 音频仅由前端播放，不会出现后端与前端重音。
- Electron 桌面窗口会在屏幕中下部显示字幕，字幕文本来自 `qa_library.json` 中的 `answer_text`，并按音频时长粗略分段同步。

## 7. 低延迟与准确率建议

1. 问题文本尽量口语化，覆盖常见说法。
2. 默认匹配阈值为 `40`，更容易触发；如果误匹配较多，可以调高到 `70~80`。
3. 使用较短且清晰的答案音频。
4. 在安静环境中测试麦克风输入，避免底噪。
5. 如果 CPU 够用，可尝试更大模型换取更高准确率（延迟会增加）。

## 8. 离线运行说明

- 识别、匹配、模型渲染、音频播放全部可在本地进行。
- 仅依赖安装阶段可能需要联网。
- 当前 `web/index.html` 使用 CDN 引入 `pixi.js` 和 `pixi-live2d-display`。
- 若需严格离线，请把这两个库改为本地文件并替换脚本标签路径。
