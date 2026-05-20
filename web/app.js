(() => {
  const connStatusEl = document.getElementById("conn-status");
  const talkStatusEl = document.getElementById("talk-status");
  const fallbackAvatar = document.getElementById("fallback-avatar");
  const canvas = document.getElementById("live2d-canvas");
  const subtitleBox = document.getElementById("subtitle-box");
  const params = new URLSearchParams(location.search);
  const desktopMode = params.get("desktop") === "1";

  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

  let modelUrl = "/live2d/wanko_touch.model3.json";
  let mouthParamIds = ["ParamMouthOpenY", "PARAM_MOUTH_OPEN_Y"];
  let ws = null;
  let app = null;
  let model = null;
  let audioEl = null;
  let mouthDriveActive = false;
  let usingFallback = false;
  let resizeDrag = null;
  let subtitleSegments = [];
  let lastSubtitleIndex = -1;
  let mouthPhase = 0;
  let mouthDriveStart = 0;
  let mouthParamFailed = false;
  let audioPlaybackActive = false;

  document.documentElement.classList.toggle("desktop-mode", desktopMode);
  document.body.classList.toggle("desktop-mode", desktopMode);
  document.body.classList.add("desktop-click-through");
  if (desktopMode) {
    fallbackAvatar.textContent = "";
    createDesktopResizeHandle();
  }

  window.smarttaDesktop?.onInteractionMode?.((payload) => {
    document.body.classList.toggle("desktop-click-through", payload.clickThrough);
    document.body.classList.toggle("desktop-draggable", !payload.clickThrough);
  });

  function createDesktopResizeHandle() {
    if (!window.smarttaDesktop) {
      return;
    }

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "desktop-resize-handle";
    handle.title = "拖动调整窗口大小";
    handle.setAttribute("aria-label", "拖动调整窗口大小");
    document.body.appendChild(handle);

    handle.addEventListener("pointerdown", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const bounds = await window.smarttaDesktop.getBounds();
      if (!bounds) {
        return;
      }

      resizeDrag = {
        startX: event.screenX,
        startY: event.screenY,
        startWidth: bounds.width,
        startHeight: bounds.height,
      };
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
      if (!resizeDrag) {
        return;
      }

      const width = resizeDrag.startWidth + event.screenX - resizeDrag.startX;
      const height = resizeDrag.startHeight + event.screenY - resizeDrag.startY;
      window.smarttaDesktop.resizeTo(width, height);
    });

    handle.addEventListener("pointerup", () => {
      resizeDrag = null;
    });

    handle.addEventListener("pointercancel", () => {
      resizeDrag = null;
    });
  }
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

  async function loadFrontendConfig() {
    try {
      const response = await fetch("/config", { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const config = await response.json();
      if (config.live2d_model_url) {
        modelUrl = config.live2d_model_url;
      }
      if (Array.isArray(config.mouth_param_ids) && config.mouth_param_ids.length > 0) {
        mouthParamIds = config.mouth_param_ids;
      }
    } catch {
      // keep local defaults when the config endpoint is unavailable
    }
  }

  function setTalking(isTalking, options = {}) {
    const restoreIdle = options.restoreIdle !== false;
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
      if (restoreIdle && !audioPlaybackActive) {
        playMotion(["Idle"], 0);
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
      layoutModel();
      window.addEventListener("resize", layoutModel);
      playMotion(["Idle"], 0);
    } catch (err) {
      console.error("Live2D 加载失败:", err);
      usingFallback = true;
      fallbackAvatar.style.display = "flex";
    }
  }

  function layoutModel() {
    if (!model || !canvas.clientWidth || !canvas.clientHeight) {
      return;
    }

    const fitScale = Math.min(canvas.clientWidth / model.width, canvas.clientHeight / model.height);
    model.scale.set(fitScale * (desktopMode ? 1.03 : 0.92));
    model.x = canvas.clientWidth / 2;
    model.y = canvas.clientHeight * (desktopMode ? 0.98 : 0.92);
    model.anchor.set(0.5, 1);
  }

  function playMotion(groups, index = 0) {
    if (audioPlaybackActive) {
      return;
    }
    if (!model || !model.motion) {
      return;
    }

    for (const group of groups) {
      try {
        const started = model.motion(group, index, 3);
        if (started !== false) {
          return;
        }
      } catch {
        // try the next configured motion group
      }
    }
  }

  function stopLive2DMotions() {
    if (!model) {
      return;
    }

    const motionManager = model.internalModel?.motionManager;
    const candidates = [
      [model.stopMotions, model],
      [model.stopMotion, model],
      [motionManager?.stopAllMotions, motionManager],
      [motionManager?.stopAllMotionsForAllGroups, motionManager],
      [motionManager?.stopMotionsForAllGroups, motionManager],
    ];

    for (const [stop, context] of candidates) {
      if (typeof stop !== "function") {
        continue;
      }
      try {
        stop.call(context);
      } catch {
        // try the next known motion manager shape
      }
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
        await playAnswerAudio(payload.audio, payload.subtitle || payload.text || "");
      }
    };
  }

  function cleanupAudioGraph() {
    stopMouthDrive();
    applyMouthOpen(0);
  }

  function applyMouthOpen(value) {
    if (!model || !model.internalModel || !model.internalModel.coreModel) {
      return;
    }

    const mouthOpen = Math.max(0, Math.min(1, value));
    for (const paramId of mouthParamIds) {
      try {
        model.internalModel.coreModel.setParameterValueById(paramId, mouthOpen);
      } catch (err) {
        if (!mouthParamFailed) {
          mouthParamFailed = true;
          console.warn("嘴型开合参数驱动不可用:", err);
        }
      }
    }

    try {
      model.internalModel.coreModel.setParameterValueById("PARAM_MOUTH_FORM", -0.2 + mouthOpen * 0.35);
    } catch (err) {
      if (!mouthParamFailed) {
        mouthParamFailed = true;
        console.warn("嘴型变形参数驱动不可用:", err);
      }
    }
  }

  function startMouthDrive() {
    if (!app || !app.ticker || mouthDriveActive) {
      return;
    }

    mouthDriveActive = true;
    mouthDriveStart = performance.now();
    mouthPhase = 0;
    const priority = -10000;
    app.ticker.add(driveMouthWhilePlaying, null, priority);
  }

  function stopMouthDrive() {
    if (app && app.ticker && mouthDriveActive) {
      app.ticker.remove(driveMouthWhilePlaying, null);
    }
    mouthDriveActive = false;
    applyMouthOpen(0);
  }

  function driveMouthWhilePlaying() {
    if (!audioEl || audioEl.paused || audioEl.ended) {
      stopMouthDrive();
      return;
    }

    const elapsed = (performance.now() - mouthDriveStart) / 1000;
    mouthPhase = elapsed * Math.PI * 2;
    const syllable = (Math.sin(mouthPhase * 5.5) + 1) / 2;
    const chatter = (Math.sin(mouthPhase * 9.1 + 0.9) + 1) / 2;
    const shaped = Math.pow(syllable, 0.38);
    const mouthOpen = 0.22 + shaped * 0.58 + chatter * 0.12;
    applyMouthOpen(mouthOpen);
  }

  function splitSubtitle(text) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) {
      return [];
    }

    const sentenceParts = normalized
      .split(/(?<=[。！？!?；;，,、])/u)
      .map((part) => part.trim())
      .filter(Boolean);
    const rawParts = sentenceParts.length > 0 ? sentenceParts : [normalized];
    const segments = [];

    for (const part of rawParts) {
      if (part.length <= 24) {
        segments.push(part);
        continue;
      }
      for (let i = 0; i < part.length; i += 24) {
        segments.push(part.slice(i, i + 24));
      }
    }

    return segments;
  }

  function showSubtitle(text) {
    if (!subtitleBox) {
      return;
    }
    subtitleBox.textContent = text || "";
    subtitleBox.classList.toggle("visible", Boolean(text));
  }

  function clearSubtitle() {
    subtitleSegments = [];
    lastSubtitleIndex = -1;
    showSubtitle("");
  }

  function updateSubtitleByPlayback() {
    if (!audioEl || subtitleSegments.length === 0) {
      return;
    }

    const duration = Number.isFinite(audioEl.duration) && audioEl.duration > 0
      ? audioEl.duration
      : Math.max(2.4, subtitleSegments.length * 1.8);
    const ratio = Math.min(0.999, Math.max(0, audioEl.currentTime / duration));
    const index = Math.min(subtitleSegments.length - 1, Math.floor(ratio * subtitleSegments.length));

    if (index !== lastSubtitleIndex) {
      lastSubtitleIndex = index;
      showSubtitle(subtitleSegments[index]);
    }
  }

  function prepareSubtitle(text) {
    subtitleSegments = splitSubtitle(text);
    lastSubtitleIndex = -1;
    if (subtitleSegments.length > 0) {
      showSubtitle(subtitleSegments[0]);
      lastSubtitleIndex = 0;
    } else {
      clearSubtitle();
    }
  }

  async function playAnswerAudio(audioPath, subtitleText = "") {
    if (audioEl) {
      audioEl.pause();
      audioEl = null;
    }
    cleanupAudioGraph();
    clearSubtitle();

    audioEl = new Audio(audioPath);
    audioEl.preload = "auto";
    prepareSubtitle(subtitleText);

    audioEl.onplay = () => {
      audioPlaybackActive = true;
      stopLive2DMotions();
      setTalking(true);
      updateSubtitleByPlayback();
      startMouthDrive();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_started" }));
      }
    };

    audioEl.ontimeupdate = () => {
      updateSubtitleByPlayback();
    };

    audioEl.onended = () => {
      audioPlaybackActive = false;
      clearSubtitle();
      cleanupAudioGraph();
      setTalking(false);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_finished" }));
      }
    };

    audioEl.onerror = () => {
      audioPlaybackActive = false;
      clearSubtitle();
      cleanupAudioGraph();
      setTalking(false);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_finished" }));
      }
    };

    try {
      await audioEl.play();
    } catch (err) {
      console.error("音频播放失败:", err);
      audioPlaybackActive = false;
      clearSubtitle();
      cleanupAudioGraph();
      setTalking(false);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_finished" }));
      }
    }
  }

  window.addEventListener("resize", () => {
    layoutModel();
  });

  (async () => {
    setConnStatus("初始化中...");
    try {
      await loadFrontendConfig();
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
