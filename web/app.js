(() => {
  const connStatusEl = document.getElementById("conn-status");
  const talkStatusEl = document.getElementById("talk-status");
  const fallbackAvatar = document.getElementById("fallback-avatar");
  const canvas = document.getElementById("live2d-canvas");

  const modelUrl = "/hiyori/hiyori_pro_t11.model3.json";
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

  let ws = null;
  let app = null;
  let model = null;
  let audioCtx = null;
  let analyser = null;
  let audioEl = null;
  let rafId = null;
  let usingFallback = false;
  const scriptLoaders = [
    {
      name: "pixi",
      urls: [
        "https://cdn.jsdelivr.net/npm/pixi.js@6/dist/browser/pixi.min.js",
        "https://unpkg.com/pixi.js@6/dist/browser/pixi.min.js",
        "https://cdn.bootcdn.net/ajax/libs/pixi.js/6.5.10/browser/pixi.min.js",
      ],
      test: () => !!window.PIXI,
    },
    {
      name: "live2dcubismcore",
      urls: [
        "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js",
        "https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display@master/test/assets/live2d/core/live2dcubismcore.min.js",
      ],
      test: () => !!window.Live2DCubismCore,
    },
    {
      name: "pixi-live2d-cubism4",
      urls: [
        "https://cdn.jsdelivr.net/npm/pixi-live2d-display/dist/cubism4.min.js",
        "https://unpkg.com/pixi-live2d-display/dist/cubism4.min.js",
      ],
      test: () => !!window?.PIXI?.live2d,
    },
    {
      name: "pixi-live2d",
      urls: [
        "https://cdn.jsdelivr.net/npm/pixi-live2d-display/dist/index.min.js",
        "https://unpkg.com/pixi-live2d-display/dist/index.min.js",
      ],
      test: () => !!window?.PIXI?.live2d?.Live2DModel,
    },
  ];

  function setConnStatus(text) {
    connStatusEl.textContent = text;
  }

  function setTalkStatus(text) {
    talkStatusEl.textContent = `状态: ${text}`;
  }

  function setTalking(isTalking) {
    if (isTalking) {
      setTalkStatus("说话中");
      fallbackAvatar.classList.remove("idle");
      fallbackAvatar.classList.add("talking");
      fallbackAvatar.style.display = usingFallback ? "flex" : "none";
    } else {
      setTalkStatus("待机");
      fallbackAvatar.classList.remove("talking");
      fallbackAvatar.classList.add("idle");
      fallbackAvatar.style.display = usingFallback ? "flex" : "none";
      if (model && model.motion) {
        model.motion("Idle", 0, 3);
      }
    }
  }

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = false;
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error(`加载失败: ${url}`));
      document.head.appendChild(script);
    });
  }

  async function ensureExternalDeps() {
    for (const loader of scriptLoaders) {
      if (loader.test()) continue;
      let ok = false;
      for (const url of loader.urls) {
        try {
          await loadScript(url);
          if (loader.test()) {
            ok = true;
            break;
          }
        } catch {
          // try next mirror
        }
      }
      if (!ok) {
        throw new Error(`依赖加载失败: ${loader.name}`);
      }
    }
  }

  async function initLive2D() {
    const PIXI = window.PIXI;
    const Live2DModel = window?.PIXI?.live2d?.Live2DModel;
    if (!PIXI || !Live2DModel) {
      usingFallback = true;
      fallbackAvatar.style.display = "flex";
      return;
    }

    app = new PIXI.Application({
      view: canvas,
      autoStart: true,
      resizeTo: canvas.parentElement,
      backgroundAlpha: 0,
      antialias: true,
    });

    try {
      model = await Live2DModel.from(modelUrl);
      app.stage.addChild(model);
      const scale = Math.min(canvas.clientWidth / model.width, canvas.clientHeight / model.height) * 0.92;
      model.scale.set(scale);
      model.x = canvas.clientWidth / 2;
      model.y = canvas.clientHeight * 0.92;
      model.anchor.set(0.5, 1);
      if (model.motion) {
        model.motion("Idle", 0, 3);
      }
    } catch (err) {
      console.error("Live2D 加载失败:", err);
      usingFallback = true;
      fallbackAvatar.style.display = "flex";
    }
  }

  function connectWebSocket() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnStatus("已连接后端");
      ws.send(JSON.stringify({ type: "frontend_ready" }));
    };

    ws.onclose = () => {
      setConnStatus("连接断开，重连中...");
      setTimeout(connectWebSocket, 1000);
    };

    ws.onerror = () => {
      setConnStatus("连接异常");
    };

    ws.onmessage = async (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type === "play_audio" && payload.audio) {
        await playAnswerAudio(payload.audio);
      }
    };
  }

  function cleanupAudioGraph() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (analyser) {
      analyser.disconnect();
      analyser = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
  }

  function driveMouthByVolume() {
    if (!analyser) return;
    const dataArray = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i += 1) {
      const v = (dataArray[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    const mouthOpen = Math.min(1, rms * 7.5);

    try {
      if (model && model.internalModel && model.internalModel.coreModel) {
        model.internalModel.coreModel.setParameterValueById("ParamMouthOpenY", mouthOpen);
      }
    } catch {
      usingFallback = true;
      fallbackAvatar.style.display = "flex";
    }

    rafId = requestAnimationFrame(driveMouthByVolume);
  }

  async function playAnswerAudio(audioPath) {
    if (audioEl) {
      audioEl.pause();
      audioEl = null;
    }
    cleanupAudioGraph();

    audioEl = new Audio(audioPath);
    audioEl.preload = "auto";

    audioEl.onplay = () => {
      setTalking(true);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_started" }));
      }
      if (model && model.motion) {
        model.motion("TapBody", 0, 3);
      }
    };

    audioEl.onended = () => {
      setTalking(false);
      cleanupAudioGraph();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_finished" }));
      }
    };

    audioEl.onerror = () => {
      setTalking(false);
      cleanupAudioGraph();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_finished" }));
      }
    };

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      const source = audioCtx.createMediaElementSource(audioEl);
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      driveMouthByVolume();
    } catch (err) {
      console.warn("音量口型驱动不可用，使用简化动画:", err);
      usingFallback = true;
      fallbackAvatar.style.display = "flex";
    }

    try {
      await audioEl.play();
    } catch (err) {
      console.error("音频播放失败:", err);
      setTalking(false);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_finished" }));
      }
    }
  }

  window.addEventListener("resize", () => {
    if (!app || !model || !canvas) return;
    const scale = Math.min(canvas.clientWidth / model.width, canvas.clientHeight / model.height) * 0.92;
    model.scale.set(scale);
    model.x = canvas.clientWidth / 2;
    model.y = canvas.clientHeight * 0.92;
  });

  (async () => {
    setConnStatus("初始化中...");
    try {
      await ensureExternalDeps();
      await initLive2D();
    } catch (err) {
      console.error("前端依赖加载失败:", err);
      setConnStatus("Live2D 依赖加载失败");
      usingFallback = true;
      fallbackAvatar.style.display = "flex";
    }
    connectWebSocket();
    setTalking(false);
  })();
})();
