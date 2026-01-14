// src/router.js
const crypto = require("crypto");
const { sendJson, readJson, parseUrl } = require("./common/http");
const { MemoryTaskStore } = require("./task/MemoryTaskStore");
const { MemorySessionStore } = require("./session/MemorySessionStore");
const { SessionService } = require("./session/SessionService");
const { AvatarService } = require("./avatar/AvatarService");
const { VoiceService } = require("./voice/VoiceService");
const { StoryService } = require("./story/StoryService");
const { ImageService } = require("./image/ImageService");
const { VideoService } = require("./video/VideoService");





// ===== 可调配置：session 未访问多久删除 =====
// 你可以在 FC 环境变量设置：SESSION_TTL_MS=86400000 (24h)
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000);

const taskStore = new MemoryTaskStore();
const sessionStore = new MemorySessionStore({ ttlMs: SESSION_TTL_MS });
const sessionService = new SessionService({ sessionStore });

const avatarService = new AvatarService({ taskStore, sessionService });
const voiceService = new VoiceService({ taskStore, sessionService });
const storyService = new StoryService({ taskStore, sessionService });
const imageService = new ImageService({ taskStore, sessionService });
const videoService = new VideoService({ taskStore, sessionService });




// 定时清理过期 session（惰性清理 + 主动清理双保险）
setInterval(() => {
  try {
    sessionStore.sweepExpired();
  } catch {}
}, 5 * 60 * 1000);

async function router(req, res) {
  const { pathname, query } = parseUrl(req);

  // health
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, ts: Date.now() });
    return true;
  }

  // ====== 查询 session（会 touch，延长 TTL）======
  // GET /api/session/:sessionId
  {
    const m = pathname.match(/^\/api\/session\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const sessionId = m[1];
      const sess = sessionService.get(sessionId);
      if (!sess) {
        sendJson(res, 404, { error: "session_not_found_or_expired" });
        return true;
      }
      sendJson(res, 200, sess);
      return true;
    }
  }

  // ====== 通用写入 artifacts（可扩展）======
  // POST /api/session/:sessionId/artifacts/:namespace
  // body: 任意小 JSON（不要 base64 / 大二进制）
  {
    const m = pathname.match(/^\/api\/session\/([^/]+)\/artifacts\/([^/]+)$/);
    if (req.method === "POST" && m) {
      const sessionId = m[1];
      const namespace = m[2];

      let body;
      try {
        body = await readJson(req);
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return true;
      }

      // 简单保护：避免有人把超大内容塞进 session
      const raw = JSON.stringify(body || {});
      if (raw.length > 200 * 1024) {
        sendJson(res, 413, { error: "artifact_payload_too_large" });
        return true;
      }

      const sess = sessionService.writeArtifact(sessionId, namespace, body || {});
      sendJson(res, 200, { ok: true, session: sess });
      return true;
    }
  }

  // ====== TTS 单测（DashScope qwen3-tts-flash）======
  // GET /api/tts/test?text=你好
  // 作用：不走 ASR/LLM，直接验证 TTS 是否能返回音频 dataUrl
  if (req.method === "GET" && pathname === "/api/tts/test") {
    const text = String((query && query.text) || "你好，我是语音播报测试。").slice(0, 800);
    try {
      const ret = await voiceService.testTts(text);
      sendJson(res, 200, {
        ok: true,
        text,
        audioDataUrl: ret.dataUrl,
        mimeType: ret.mimeType,
        format: ret.format,
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message || String(e) });
    }
    return true;
  }

  // ====== start avatar task ======
  if (req.method === "POST" && pathname === "/api/avatar/stylize/start") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return true;
    }

    const sessionId = body?.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      sendJson(res, 400, { error: "missing_sessionId" });
      return true;
    }

    if (!body?.imageBase64 || typeof body.imageBase64 !== "string") {
      sendJson(res, 400, { error: "missing_imageBase64" });
      return true;
    }

    // payload 保护
    if (body.imageBase64.length > 15 * 1024 * 1024) {
      sendJson(res, 413, { error: "image_too_large" });
      return true;
    }

    // ✅ 确保 session 存在（后续落 avatar 结果）
    sessionService.ensure(sessionId);

    const taskId = crypto.randomUUID();
    const now = Date.now();

    // ✅ 大字段临时保存，不进 taskStore
    const imageBase64 = body.imageBase64;

    const task = {
      taskId,
      sessionId,
      type: "AVATAR",
      status: "PENDING",
      progress: 0,
      input: {
        styleId: body.styleId || "comic",
        size: body.size || "2K",
      },
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };

    taskStore.create(task);
    sessionService.setStage(sessionId, "AVATAR_PENDING");

    avatarService.startTask(taskId, {
      sessionId,
      styleId: task.input.styleId,
      size: task.input.size,
      imageBase64,
    });

    sendJson(res, 200, { taskId, status: task.status, sessionId });
    return true;
  }

  // ====== start voice dialog (A1: ASR + LLM + TTS) ======
  // POST /api/voice/dialog/start
  // body: { sessionId, audioBase64(dataUrl), mimeType }
  if (req.method === "POST" && pathname === "/api/voice/dialog/start") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return true;
    }

    const sessionId = body?.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      sendJson(res, 400, { error: "missing_sessionId" });
      return true;
    }

    const audioBase64 = body?.audioBase64;
    if (!audioBase64 || typeof audioBase64 !== "string") {
      sendJson(res, 400, { error: "missing_audioBase64" });
      return true;
    }

    const mimeType = typeof body?.mimeType === "string" ? body.mimeType : "";

    // dataURL: data:audio/webm;codecs=opus;base64,xxxx
    const commaIdx = audioBase64.indexOf(",");
    const b64 = commaIdx >= 0 ? audioBase64.slice(commaIdx + 1) : audioBase64;

    // base64 长度保护（按需调整）
    if (b64.length > 16 * 1024 * 1024) {
      sendJson(res, 413, { error: "audio_too_large" });
      return true;
    }

    // 确保 session 存在
    sessionService.ensure(sessionId);
    sessionService.setStage(sessionId, "VOICE_DIALOG_PENDING");

    const taskId = crypto.randomUUID();
    const now = Date.now();

    // 注意：task 里不要存大音频
    taskStore.create({
      taskId,
      sessionId,
      type: "VOICE_DIALOG",
      status: "PENDING",
      progress: 0,
      input: { mimeType: mimeType || "unknown" },
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });

    // ✅ 传纯 base64 给 worker（不转 Buffer）
    voiceService.startDialogTask(taskId, {
      sessionId,
      audioBase64DataOnly: b64,
      mimeType,
    });

    sendJson(res, 200, { taskId, status: "PENDING", sessionId });
    return true;
  }

  // ====== start story generate (LLM) ======
  // POST /api/story/generate/start
  // body: { sessionId, lengthHint?, language? }
  if (req.method === "POST" && pathname === "/api/story/generate/start") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return true;
    }

    const sessionId = body?.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      sendJson(res, 400, { error: "missing_sessionId" });
      return true;
    }

    const lengthHint = typeof body?.lengthHint === "string" ? body.lengthHint : "";
    const language = typeof body?.language === "string" ? body.language : "zh";

    sessionService.ensure(sessionId);
    sessionService.setStage(sessionId, "STORY_GEN_PENDING");

    const taskId = crypto.randomUUID();
    const now = Date.now();

    taskStore.create({
      taskId,
      sessionId,
      type: "STORY_GEN",
      status: "PENDING",
      progress: 0,
      input: { lengthHint, language },
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });

    storyService.startGenerateStoryTask(taskId, {
      sessionId,
      lengthHint,
      language,
    });

    sendJson(res, 200, { taskId, status: "PENDING", sessionId });
    return true;
  }

  // ====== start story split (LLM) ======
  // POST /api/story/split/start
  // body: { sessionId, maxScenes? }
  if (req.method === "POST" && pathname === "/api/story/split/start") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return true;
    }

    const sessionId = body?.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      sendJson(res, 400, { error: "missing_sessionId" });
      return true;
    }

    let maxScenes = 6;
    if (typeof body?.maxScenes === "number" && Number.isFinite(body.maxScenes)) {
      maxScenes = Math.round(body.maxScenes);
    } else if (typeof body?.maxScenes === "string" && body.maxScenes.trim()) {
      const n = Number(body.maxScenes);
      if (Number.isFinite(n)) maxScenes = Math.round(n);
    }
    maxScenes = Math.min(Math.max(maxScenes, 3), 10);

    sessionService.ensure(sessionId);
    sessionService.setStage(sessionId, "SPLIT_PENDING");

    const taskId = crypto.randomUUID();
    const now = Date.now();

    taskStore.create({
      taskId,
      sessionId,
      type: "STORY_SPLIT",
      status: "PENDING",
      progress: 0,
      input: { maxScenes },
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });

    storyService.startSplitStoryTask(taskId, {
      sessionId,
      maxScenes,
    });

    sendJson(res, 200, { taskId, status: "PENDING", sessionId });
    return true;
  }

  // ====== start scene images generate (Seedream) ======
// POST /api/image/scenes/start
// body: { sessionId, size?, watermark? }
if (req.method === "POST" && pathname === "/api/image/scenes/start") {
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return true;
  }

  const sessionId = body?.sessionId;
  if (!sessionId || typeof sessionId !== "string") {
    sendJson(res, 400, { error: "missing_sessionId" });
    return true;
  }

  const size = typeof body?.size === "string" ? body.size : "2K";
  const watermark = body?.watermark !== false; // 默认 true

  sessionService.ensure(sessionId);
  sessionService.setStage(sessionId, "IMAGES_PENDING");

  const taskId = crypto.randomUUID();
  const now = Date.now();

  taskStore.create({
    taskId,
    sessionId,
    type: "SCENE_IMAGES",
    status: "PENDING",
    progress: 0,
    input: { size, watermark },
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });

  imageService.startGenerateSceneImagesTask(taskId, { sessionId, size, watermark });

  sendJson(res, 200, { taskId, status: "PENDING", sessionId });
  return true;
}


// ====== image test ======
// GET /api/image/test
if (req.method === "GET" && pathname === "/api/image/test") {
  try {
    const { ImageProvider } = require("./image/ImageProvider");
    const img = new ImageProvider();

    const ret = await img.generate({
      prompt: "童话绘本风格，一只小兔子在彩虹花田里，阳光明亮，温暖可爱。",
      images: null,
      size: "2K",
      watermark: true,
    });

    sendJson(res, 200, { ok: true, providerVersion: ret.providerVersion, url: ret.url });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e?.message || String(e) });
  }
  return true;
}

  // ====== start video clips generate ======
// POST /api/video/start
// body: { sessionId, clipDuration?, watermark? }
if (req.method === "POST" && pathname === "/api/video/start") {
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return true;
  }

  const sessionId = body?.sessionId;
  if (!sessionId || typeof sessionId !== "string") {
    sendJson(res, 400, { error: "missing_sessionId" });
    return true;
  }

  const sess = sessionService.get(sessionId);
  if (!sess) {
    sendJson(res, 404, { error: "session_not_found_or_expired" });
    return true;
  }

  const clipDuration = typeof body?.clipDuration === "number" ? body.clipDuration : 5;
  const watermark = body?.watermark !== false;

  const clipCount = Array.isArray(sess?.artifacts?.sceneImages?.items)
    ? sess.artifacts.sceneImages.items.length
    : 0;

  if (!clipCount) {
    sendJson(res, 400, { error: "no_scene_images" });
    return true;
  }

  sessionService.setStage(sessionId, "VIDEO_PENDING");

  const taskId = crypto.randomUUID();
  const now = Date.now();

  taskStore.create({
    taskId,
    sessionId,
    type: "VIDEO_CLIPS",
    status: "PENDING",
    progress: 0,
    input: { clipDuration, watermark, clipCount },
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });

  videoService.startGenerateClipsTask(taskId, { sessionId, clipDuration, watermark });

  sendJson(res, 200, { taskId, status: "PENDING", sessionId, clipCount });
  return true;
}





  // ====== poll task ======
  {
    const m = pathname.match(/^\/api\/task\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const task = taskStore.get(m[1]);
      if (!task) {
        sendJson(res, 404, { error: "task_not_found" });
        return true;
      }
      sendJson(res, 200, task);
      return true;
    }
  }

  return false;
}

module.exports = { router };
