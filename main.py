#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import asyncio
import json
import os
import queue
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

from aiohttp import WSMsgType, web
from rapidfuzz import fuzz, process
from vosk import KaldiRecognizer, Model, SetLogLevel

try:
    import sounddevice as sd
except OSError as exc:
    if "PortAudio library not found" in str(exc):
        raise SystemExit(
            "sounddevice 缺少 PortAudio 运行库。\n"
            "如果你在 conda 环境，执行：conda install -c conda-forge portaudio\n"
            "如果你在 Ubuntu/Debian，执行：sudo apt-get install -y portaudio19-dev libportaudio2\n"
            "安装后重新运行 main.py。"
        ) from exc
    raise


SetLogLevel(-1)


@dataclass
class QAItem:
    question: str
    answer_audio: str


class FrontendBridge:
    """Bridge between recognition thread and browser frontend over WebSocket."""

    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.ws_clients: set[web.WebSocketResponse] = set()
        self.pause_listening = threading.Event()
        self.playback_done = threading.Event()

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    def register_ws(self, ws: web.WebSocketResponse) -> None:
        self.ws_clients.add(ws)

    def unregister_ws(self, ws: web.WebSocketResponse) -> None:
        self.ws_clients.discard(ws)

    async def _broadcast(self, payload: dict) -> None:
        dead: List[web.WebSocketResponse] = []
        for ws in self.ws_clients:
            if ws.closed:
                dead.append(ws)
                continue
            await ws.send_str(json.dumps(payload, ensure_ascii=False))
        for ws in dead:
            self.ws_clients.discard(ws)

    def send_event(self, payload: dict) -> None:
        if not self.loop:
            return
        asyncio.run_coroutine_threadsafe(self._broadcast(payload), self.loop)

    def request_playback(self, audio_relpath: str, timeout: float = 20.0) -> None:
        self.pause_listening.set()
        self.playback_done.clear()
        self.send_event({"type": "play_audio", "audio": "/" + audio_relpath.replace("\\", "/")})
        finished = self.playback_done.wait(timeout=timeout)
        if not finished:
            print("前端播放超时，恢复监听。")
        self.pause_listening.clear()


def load_qa_library(path: str) -> List[QAItem]:
    if not os.path.exists(path):
        raise FileNotFoundError(f"问答库文件不存在: {path}")

    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    items: List[QAItem] = []
    for i, row in enumerate(raw):
        if "question" not in row or "answer_audio" not in row:
            raise ValueError(f"问答库第 {i} 项缺少 question 或 answer_audio")
        items.append(QAItem(question=row["question"], answer_audio=row["answer_audio"]))
    return items


class VoiceAssistant:
    def __init__(
        self,
        model_path: str,
        qa_items: List[QAItem],
        confidence_threshold: int,
        samplerate: int,
        device: Optional[int],
        blocksize: int,
        silence_timeout: float,
        bridge: FrontendBridge,
    ) -> None:
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Vosk 模型目录不存在: {model_path}")
        if not qa_items:
            raise ValueError("问答库为空")

        self.model = Model(model_path)
        self.recognizer = KaldiRecognizer(self.model, samplerate)
        self.qa_items = qa_items
        self.questions = [x.question for x in qa_items]
        self.confidence_threshold = confidence_threshold
        self.samplerate = samplerate
        self.device = device
        self.blocksize = blocksize
        self.silence_timeout = silence_timeout
        self.audio_queue: "queue.Queue[bytes]" = queue.Queue(maxsize=32)
        self.bridge = bridge
        self._running = threading.Event()
        self._running.set()

    def _audio_callback(self, indata, frames, time_info, status):
        if status:
            print(f"[音频状态] {status}", file=sys.stderr)
        try:
            self.audio_queue.put_nowait(bytes(indata))
        except queue.Full:
            pass

    def _match_question(self, text: str) -> Tuple[Optional[QAItem], float]:
        best = process.extractOne(
            text,
            self.questions,
            scorer=fuzz.WRatio,
            score_cutoff=0,
        )
        if best is None:
            return None, 0.0
        best_question, score, idx = best
        return self.qa_items[idx], float(score)

    def run(self) -> None:
        print("语音助手启动。按 Ctrl+C 退出。")
        print("开始监听麦克风...")

        with sd.RawInputStream(
            samplerate=self.samplerate,
            blocksize=self.blocksize,
            device=self.device,
            dtype="int16",
            channels=1,
            callback=self._audio_callback,
        ):
            while self._running.is_set():
                if self.bridge.pause_listening.is_set():
                    self._drain_audio_queue()
                    time.sleep(0.03)
                    continue

                try:
                    data = self.audio_queue.get(timeout=self.silence_timeout)
                except queue.Empty:
                    continue

                if self.recognizer.AcceptWaveform(data):
                    result_json = json.loads(self.recognizer.Result())
                    text = result_json.get("text", "").strip()
                    if not text:
                        continue
                    self._handle_text(text)

                else:
                    partial_json = json.loads(self.recognizer.PartialResult())
                    partial_text = partial_json.get("partial", "").strip()
                    if partial_text:
                        print(f"\r识别中: {partial_text}   ", end="", flush=True)

    def _handle_text(self, text: str) -> None:
        print(f"\n识别结果: {text}")
        matched_item, score = self._match_question(text)

        if matched_item is None:
            print("未找到匹配项。")
            return

        print(f"匹配问题: {matched_item.question} (相似度: {score:.1f})")
        if score < self.confidence_threshold:
            print(
                f"相似度低于阈值 {self.confidence_threshold}，忽略本次触发。"
            )
            return

        audio_path = matched_item.answer_audio
        if not os.path.exists(audio_path):
            print(f"答案音频不存在: {audio_path}")
            return

        print(f"通知前端播放答案音频: {audio_path}")
        self.bridge.request_playback(audio_path)

    def _drain_audio_queue(self) -> None:
        while True:
            try:
                self.audio_queue.get_nowait()
            except queue.Empty:
                break


def create_web_app(bridge: FrontendBridge, base_dir: Path) -> web.Application:
    web_dir = base_dir / "web"
    answers_dir = base_dir / "answers"
    hiyori_runtime_dir = base_dir / "hiyori_pro_zh" / "runtime"

    app = web.Application()

    async def index(_request: web.Request) -> web.Response:
        return web.FileResponse(web_dir / "index.html")

    async def ws_handler(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        bridge.register_ws(ws)
        await ws.send_str(json.dumps({"type": "status", "message": "connected"}, ensure_ascii=False))
        print("前端已连接。")
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    payload = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue

                msg_type = payload.get("type")
                if msg_type == "audio_started":
                    bridge.pause_listening.set()
                elif msg_type == "audio_finished":
                    bridge.playback_done.set()
                    bridge.pause_listening.clear()
                elif msg_type == "frontend_ready":
                    print("前端已就绪。")
        finally:
            bridge.unregister_ws(ws)
            print("前端连接断开。")
        return ws

    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_static("/web/", path=str(web_dir), show_index=False)
    app.router.add_static("/answers/", path=str(answers_dir), show_index=False)
    app.router.add_static("/hiyori/", path=str(hiyori_runtime_dir), show_index=False)
    return app


async def start_web_server(bridge: FrontendBridge, host: str, port: int, base_dir: Path) -> web.AppRunner:
    app = create_web_app(bridge, base_dir)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host=host, port=port)
    await site.start()
    print(f"前端地址: http://{host}:{port}")
    return runner


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="离线语音助手: 语音识别 -> 文本模糊匹配 -> 播放答案语音"
    )
    parser.add_argument(
        "--model-path",
        default="model/vosk-model-small-cn-0.22",
        help="Vosk 模型目录路径",
    )
    parser.add_argument(
        "--qa-path",
        default="qa_library.json",
        help="问答库 JSON 文件路径",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=72,
        help="模糊匹配阈值(0-100)，默认 72",
    )
    parser.add_argument(
        "--samplerate",
        type=int,
        default=16000,
        help="麦克风采样率，默认 16000",
    )
    parser.add_argument(
        "--blocksize",
        type=int,
        default=4000,
        help="音频分块大小，默认 4000（约 0.25 秒 @16k）",
    )
    parser.add_argument(
        "--device",
        type=int,
        default=None,
        help="输入设备 ID（可选）",
    )
    parser.add_argument(
        "--silence-timeout",
        type=float,
        default=0.6,
        help="队列读取超时（秒）",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Web 服务监听地址",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Web 服务端口",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    base_dir = Path(__file__).resolve().parent
    qa_items = load_qa_library(args.qa_path)
    bridge = FrontendBridge(base_dir=base_dir)
    assistant = VoiceAssistant(
        model_path=args.model_path,
        qa_items=qa_items,
        confidence_threshold=args.threshold,
        samplerate=args.samplerate,
        device=args.device,
        blocksize=args.blocksize,
        silence_timeout=args.silence_timeout,
        bridge=bridge,
    )
    loop = asyncio.new_event_loop()
    bridge.set_loop(loop)
    asyncio.set_event_loop(loop)

    def run_assistant() -> None:
        try:
            assistant.run()
        except Exception as exc:
            print(f"识别线程异常: {exc}", file=sys.stderr)

    assistant_thread = threading.Thread(target=run_assistant, daemon=True)
    assistant_thread.start()

    runner: Optional[web.AppRunner] = None
    try:
        runner = loop.run_until_complete(
            start_web_server(bridge, host=args.host, port=args.port, base_dir=base_dir)
        )
        loop.run_forever()
    except KeyboardInterrupt:
        print("\n已退出。")
    finally:
        if runner is not None:
            loop.run_until_complete(runner.cleanup())
        loop.stop()
        loop.close()


if __name__ == "__main__":
    main()
