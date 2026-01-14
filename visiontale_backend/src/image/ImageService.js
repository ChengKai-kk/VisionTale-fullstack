// src/image/ImageService.js
const crypto = require("crypto");
const { ImageProvider } = require("./ImageProvider");
const { LlmProvider } = require("../voice/LlmProvider");

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractJson(text) {
  const t = String(text || "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("llm_no_json");
  return JSON.parse(m[0]);
}

function isRetryableNetworkError(err) {
  const msg = String(err?.message || err || "");
  // 我们的 ImageProvider 会抛：imgprov_https_only_v3:image_https_failed:ECONNRESET:...
  // 也可能是 node https 原生错误：ECONNRESET / ETIMEDOUT / ENOTFOUND / EAI_AGAIN
  return (
    msg.includes(":ECONNRESET:") ||
    msg.includes(":ETIMEDOUT:") ||
    msg.includes(":ENOTFOUND:") ||
    msg.includes(":EAI_AGAIN:") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("EAI_AGAIN")
  );
}

/**
 * 带指数退避 + jitter 的重试
 * @param {() => Promise<any>} fn
 * @param {{retries?:number, baseDelayMs?:number, maxDelayMs?:number, onAttempt?:(n:number, e:any)=>void}} opt
 */
async function withRetry(fn, opt = {}) {
  const retries = Number(opt.retries ?? 3);
  const baseDelayMs = Number(opt.baseDelayMs ?? 600);
  const maxDelayMs = Number(opt.maxDelayMs ?? 4500);

  let lastErr = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (opt.onAttempt) opt.onAttempt(attempt, e);

      // 最后一次不等了，直接抛
      if (attempt >= retries) break;

      // 不可重试则立刻抛
      if (!isRetryableNetworkError(e)) break;

      // backoff + jitter
      const expo = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 220);
      await sleep(expo + jitter);
    }
  }

  throw lastErr;
}

/**
 * 逐场景生成图像（逐张写回 session.artifacts.sceneImages.items）
 * 依赖：
 * - session.artifacts.avatar.url
 * - session.artifacts.scenes.items[]
 */
class ImageService {
  constructor({ taskStore, sessionService }) {
    this.taskStore = taskStore;
    this.sessionService = sessionService;
    this.img = new ImageProvider();
    this.llm = new LlmProvider();
  }

  startGenerateSceneImagesTask(taskId, input) {
    setImmediate(() => this._run(taskId, input));
  }

  async _run(taskId, input) {
    const sessionId = input?.sessionId;
    try {
      this.taskStore.patch(taskId, {
        status: "RUNNING",
        progress: 5,
        stage: "LOAD_SESSION",
        updatedAt: now(),
      });

      const sess = this.sessionService.get(sessionId) || this.sessionService.ensure(sessionId);

      const avatarUrl = String(sess?.artifacts?.avatar?.url || "").trim();
      if (!avatarUrl) throw new Error("missing_avatar_url");

      const scenesNode = sess?.artifacts?.scenes || {};
      const scenesIn = Array.isArray(scenesNode.items) ? scenesNode.items : [];
      if (!scenesIn.length) throw new Error("missing_scenes_items");

      // 只取 order 排序后的 scenes
      const scenes = scenesIn
        .slice()
        .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
        .map((s, idx) => ({
          id: String(s.id || crypto.randomUUID()),
          order: Number(s.order || idx + 1),
          sceneTitle: String(s.sceneTitle || "").trim(),
          sceneText: String(s.sceneText || "").trim(),
          imagePrompt: String(s.imagePrompt || "").trim(),
          narration: String(s.narration || "").trim(),
        }))
        .filter((s) => s.order > 0);

      this.sessionService.setStage(sessionId, "IMAGES_RUNNING");

      // ====== 1) LLM 判定 includeHero ======
      this.taskStore.patch(taskId, {
        progress: 12,
        stage: "LLM_DECIDE_HERO",
        updatedAt: now(),
      });

      const storyReq = sess?.artifacts?.storyReq || {};
      const llmDecisions = await this._decideIncludeHero({ storyReq, scenes });

      const decisionMap = new Map();
      for (const d of llmDecisions) {
        if (!d?.sceneId) continue;
        decisionMap.set(String(d.sceneId), {
          includeHero: !!d.includeHero,
          promptExtra: String(d.promptExtra || "").trim(),
        });
      }

      // ====== 2) 逐张生成（支持断点续跑） ======
      const size = input?.size || "2K";
      const watermark = input?.watermark !== false;

      // 读已有
      const existingNode = sess?.artifacts?.sceneImages || {};
      const existingItems = Array.isArray(existingNode.items) ? existingNode.items.slice() : [];

      // ✅ 断点续跑：用 sceneId + order 双保险
      const doneSceneIdSet = new Set(
        existingItems
          .filter((x) => x && x.imageUrl)
          .map((x) => String(x.sceneId || ""))
          .filter(Boolean)
      );
      const doneOrderSet = new Set(
        existingItems
          .filter((x) => x && x.imageUrl)
          .map((x) => Number(x.order || 0))
          .filter((n) => n > 0)
      );

      // ✅ prevImageUrl：取“最大 order 且有 imageUrl”的那张
      let prevImageUrl = "";
      const existingSorted = existingItems
        .filter((x) => x && x.imageUrl)
        .slice()
        .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      if (existingSorted.length) prevImageUrl = String(existingSorted[existingSorted.length - 1].imageUrl || "").trim();

      const total = scenes.length;
      let successCount = existingItems.filter((x) => x && x.imageUrl).length;
      let errorCount = 0;

      for (let i = 0; i < scenes.length; i++) {
        const s = scenes[i];

        // 已生成则跳过
        if (doneSceneIdSet.has(s.id) || doneOrderSet.has(s.order)) {
          // 更新 prev
          const found =
            existingItems.find((x) => String(x.sceneId || "") === s.id && x.imageUrl) ||
            existingItems.find((x) => Number(x.order || 0) === s.order && x.imageUrl);
          if (found?.imageUrl) prevImageUrl = String(found.imageUrl).trim();
          continue;
        }

        const d = decisionMap.get(s.id) || { includeHero: true, promptExtra: "" };

        const basePrefix = [
          "童话绘本/漫画插画风格，色彩温暖干净，画面细腻。",
          "不要出现文字、字幕、水印、Logo。",
          "如果提供了参考图：角色外貌以参考图中的角色为准；画面风格与色调延续参考图。",
        ].join(" ");

        const scenePart = [
          s.imagePrompt ? s.imagePrompt : "",
          s.sceneTitle ? `场景：${s.sceneTitle}` : "",
          s.sceneText ? `内容：${s.sceneText}` : "",
        ]
          .filter(Boolean)
          .join("；");

        const noHuman = d.includeHero ? "" : "画面中不要出现人类角色或小朋友（no human）。";

        const prompt = [basePrefix, scenePart, noHuman, d.promptExtra].filter(Boolean).join(" ");

        // 方案 B：多图参考
        let images = null;
        let usedRef = "";

        if (!prevImageUrl) {
          images = avatarUrl;
          usedRef = "avatar";
        } else {
          if (d.includeHero) {
            images = [avatarUrl, prevImageUrl];
            usedRef = "avatar+prev";
          } else {
            images = [prevImageUrl, avatarUrl];
            usedRef = "prev+avatar";
          }
        }

        // 任务进度/阶段
        const stageNo = s.order || i + 1;
        this.taskStore.patch(taskId, {
          progress: Math.min(95, Math.round((Math.max(0, successCount) / total) * 80) + 15),
          stage: `GEN_${stageNo}`,
          updatedAt: now(),
        });

        // ✅ 单张生成：重试 3 次（仅对网络抖动）
        let gen = null;
        let lastErrMsg = "";

        try {
          gen = await withRetry(
            async () => this.img.generate({ prompt, images, size, watermark }),
            {
              retries: 3,
              baseDelayMs: 650,
              maxDelayMs: 5000,
              onAttempt: (attempt, e) => {
                // 可选：写入 task 的 stage 信息，方便你观察重试
                const em = String(e?.message || e);
                this.taskStore.patch(taskId, {
                  stage: `GEN_${stageNo}_RETRY_${attempt}`,
                  updatedAt: now(),
                });
                lastErrMsg = em;
              },
            }
          );
        } catch (e) {
          lastErrMsg = String(e?.message || e);
        }

        const caption = s.narration || s.sceneText || s.sceneTitle || `场景 ${stageNo}`;

        if (gen && gen.url) {
          existingItems.push({
            id: crypto.randomUUID(),
            sceneId: s.id,
            order: stageNo,
            imageUrl: gen.url,
            caption,
            includeHero: d.includeHero,
            usedRef,
            createdAt: now(),
          });

          prevImageUrl = gen.url;
          successCount++;

          // 写回（逐张出现）
          this.sessionService.writeArtifact(sessionId, "sceneImages", {
            items: existingItems,
            source: "seedream",
            updatedAt: now(),
          });
        } else {
          // ✅ 失败不中断：写回失败记录（前端可显示“第 N 张失败，可重试”）
          errorCount++;

          existingItems.push({
            id: crypto.randomUUID(),
            sceneId: s.id,
            order: stageNo,
            imageUrl: "",
            caption,
            includeHero: d.includeHero,
            usedRef,
            error: lastErrMsg || "unknown_error",
            createdAt: now(),
          });

          // 也写回，让前端看到失败状态
          this.sessionService.writeArtifact(sessionId, "sceneImages", {
            items: existingItems,
            source: "seedream",
            updatedAt: now(),
          });

          // 继续下一张
          continue;
        }
      }

      // ✅ 最终状态：只要有成功就算 DONE（但带 errors）
      if (successCount <= 0) {
        throw new Error("image_all_failed");
      }

      this.sessionService.setStage(sessionId, errorCount > 0 ? "IMAGES_DONE_WITH_ERRORS" : "IMAGES_DONE");

      this.taskStore.patch(taskId, {
        status: "DONE",
        progress: 100,
        stage: errorCount > 0 ? "DONE_WITH_ERRORS" : "DONE",
        result: { images: successCount, errors: errorCount, total },
        error: errorCount > 0 ? `partial_failed:${errorCount}` : null,
        updatedAt: now(),
      });
    } catch (e) {
      this.taskStore.patch(taskId, {
        status: "FAILED",
        progress: 100,
        stage: "FAILED",
        error: e?.message || String(e),
        updatedAt: now(),
      });
      try {
        if (sessionId) this.sessionService.setStage(sessionId, "IMAGES_FAILED");
      } catch {}
    }
  }

  /**
   * 让 LLM 输出每个 scene 是否 includeHero（“是否需要小朋友/人类主角出镜”）
   */
  async _decideIncludeHero({ storyReq, scenes }) {
    const system = `
你是一个绘本分镜导演。你会收到故事需求 storyReq 和若干场景 scenes。
请判断每个场景画面里是否需要“人类主角/小朋友”出镜。

注意：
- 如果故事主角是动物（兔子/小熊等），它不算“人类主角/小朋友”。
- includeHero=true 表示“需要人类主角/小朋友出镜”；
- includeHero=false 表示“画面不要出现人类角色”，更像风景/道具/动物特写等。
- 你可以给 promptExtra 补充 1 句约束（例如：镜头远近、构图、不要多余人物等）。

只输出 JSON（不要多余文字）：
{
  "decisions":[
    {"sceneId":"...","includeHero":true/false,"promptExtra":"..."}
  ]
}
`.trim();

    const user = {
      storyReq,
      scenes: scenes.map((s) => ({
        sceneId: s.id,
        order: s.order,
        sceneTitle: s.sceneTitle,
        sceneText: s.sceneText,
        imagePrompt: s.imagePrompt,
        narration: s.narration,
      })),
    };

    const raw = await this.llm.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
    });

    try {
      const parsed = extractJson(raw);
      const arr = Array.isArray(parsed.decisions) ? parsed.decisions : [];
      return arr;
    } catch {
      return scenes.map((s) => ({ sceneId: s.id, includeHero: true, promptExtra: "" }));
    }
  }
}

module.exports = { ImageService };
