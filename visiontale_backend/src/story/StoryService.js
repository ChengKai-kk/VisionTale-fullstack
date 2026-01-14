// src/story/StoryService.js
const crypto = require("crypto");
const { LlmProvider } = require("../voice/LlmProvider");

function now() {
  return Date.now();
}

function extractJson(text) {
  const t = String(text || "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("llm_no_json");
  return JSON.parse(m[0]);
}

/**
 * 生成故事 & 拆分场景
 * - 依赖 session.artifacts.storyReq（来自多轮对话）
 * - 结果写入 session.artifacts.story / session.artifacts.scenes
 */
class StoryService {
  constructor({ taskStore, sessionService }) {
    this.taskStore = taskStore;
    this.sessionService = sessionService;
    this.llm = new LlmProvider();
  }

  /**
   * 生成故事（异步任务）
   * @param {string} taskId
   * @param {{sessionId:string, language?:string, lengthHint?:string}} input
   */
  startGenerateStoryTask(taskId, input) {
    setImmediate(() => this._runGenerateStory(taskId, input));
  }

  async _runGenerateStory(taskId, input) {
    const sessionId = input?.sessionId;
    try {
      this.taskStore.patch(taskId, {
        status: "RUNNING",
        progress: 10,
        stage: "LOAD_SESSION",
        updatedAt: now(),
      });

      const sess = this.sessionService.get(sessionId) || this.sessionService.ensure(sessionId);
      const req = sess?.artifacts?.storyReq || {};
      const avatar = sess?.artifacts?.avatar || null;

      this.sessionService.setStage(sessionId, "STORY_GEN_RUNNING");

      const system = `
你是一个给小朋友写睡前故事的作家。

要求：
- 故事必须健康、温柔、积极向上；不要出现血腥、死亡、虐待、恐怖。
- 用中文，适合 4~10 岁。
- 情节清晰：开端-发展-高潮-结尾。
- 主角要保持一致；如果有同伴也要出现。
- 尽量结合小朋友给出的设定（类型/主角/地点/氛围/结局/障碍）。
- 字数大约 400~900 字（可根据 length 调整）。

你会收到一个结构化的故事需求 storyReq，以及可能存在的头像信息 avatar（只有 URL，不要输出 URL）。
你需要输出 JSON（不要输出任何多余文本），格式：
{
  "title": "...",
  "story": "...",
  "moral": "..."
}
`.trim();

      const user = {
        storyReq: req,
        avatar: avatar ? { hasAvatar: true, styleId: avatar.styleId || null } : { hasAvatar: false },
        lengthHint: input?.lengthHint || req.length || "",
        language: input?.language || "zh",
      };

      this.taskStore.patch(taskId, {
        progress: 35,
        stage: "LLM",
        updatedAt: now(),
      });

      const assistantRaw = await this.llm.chat({
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(user) },
        ],
      });

      let parsed;
      try {
        parsed = extractJson(assistantRaw);
      } catch {
        // 兜底：有些模型会输出非 JSON
        parsed = { title: "小朋友的故事", story: String(assistantRaw || "").trim(), moral: "" };
      }

      const title = String(parsed.title || "小朋友的故事").slice(0, 80);
      const story = String(parsed.story || "").trim();
      const moral = String(parsed.moral || "").trim();

      if (!story) throw new Error("story_empty");

      this.sessionService.writeArtifact(sessionId, "story", {
        title,
        text: story,
        moral,
        source: "llm",
        updatedAt: now(),
      });
      this.sessionService.setStage(sessionId, "STORY_GEN_DONE");

      this.taskStore.patch(taskId, {
        status: "DONE",
        progress: 100,
        stage: "DONE",
        result: { title, storyLen: story.length },
        error: null,
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
        if (sessionId) this.sessionService.setStage(sessionId, "STORY_GEN_FAILED");
      } catch {}
    }
  }

  /**
   * 拆分场景（异步任务）
   * @param {string} taskId
   * @param {{sessionId:string, maxScenes?:number}} input
   */
  startSplitStoryTask(taskId, input) {
    setImmediate(() => this._runSplitStory(taskId, input));
  }

  async _runSplitStory(taskId, input) {
    const sessionId = input?.sessionId;
    try {
      this.taskStore.patch(taskId, {
        status: "RUNNING",
        progress: 10,
        stage: "LOAD_STORY",
        updatedAt: now(),
      });

      const sess = this.sessionService.get(sessionId) || this.sessionService.ensure(sessionId);
      const req = sess?.artifacts?.storyReq || {};
      const storyNode = sess?.artifacts?.story || {};
      const storyText = String(storyNode.text || "").trim();
      if (!storyText) throw new Error("missing_story_text");

      this.sessionService.setStage(sessionId, "SPLIT_RUNNING");

      const maxScenes = Math.min(Math.max(Number(input?.maxScenes || 6), 3), 10);

      const system = `
你是一个儿童故事分镜师。

输入：一个完整故事文本 story，以及结构化需求 storyReq。
输出：把故事拆成若干个“场景”，并为每个场景写一条适合文生图的提示词。

要求：
- 场景数量 4~${maxScenes} 个，覆盖开端/发展/高潮/结尾。
- 每个场景包含：sceneTitle、sceneText（1~3 句概括）、imagePrompt（中文提示词，包含主体/动作/环境/氛围/画面风格）、narration（旁白，1~2 句）。
- imagePrompt 要保持主角形象一致；如果 storyReq 有风格/氛围，请体现在 prompt。
- 不要暴力血腥恐怖。

只输出 JSON（不要输出多余文本），格式：
{
  "scenes": [
    {"sceneTitle":"...","sceneText":"...","imagePrompt":"...","narration":"..."}
  ]
}
`.trim();

      const user = {
        storyReq: req,
        story: storyText,
        maxScenes,
      };

      this.taskStore.patch(taskId, {
        progress: 35,
        stage: "LLM",
        updatedAt: now(),
      });

      const assistantRaw = await this.llm.chat({
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(user) },
        ],
      });

      let parsed;
      try {
        parsed = extractJson(assistantRaw);
      } catch {
        parsed = { scenes: [] };
      }

      const scenesIn = Array.isArray(parsed.scenes) ? parsed.scenes : [];

      const scenes = scenesIn
        .filter(Boolean)
        .slice(0, maxScenes)
        .map((s, idx) => {
          const id = crypto.randomUUID();
          return {
            id,
            order: idx + 1,
            sceneTitle: String(s.sceneTitle || `场景 ${idx + 1}`).slice(0, 80),
            sceneText: String(s.sceneText || "").trim(),
            imagePrompt: String(s.imagePrompt || "").trim(),
            narration: String(s.narration || "").trim(),
          };
        });

      if (!scenes.length) throw new Error("split_empty");

      this.sessionService.writeArtifact(sessionId, "scenes", {
        items: scenes,
        source: "llm",
        updatedAt: now(),
      });
      this.sessionService.setStage(sessionId, "SPLIT_DONE");

      this.taskStore.patch(taskId, {
        status: "DONE",
        progress: 100,
        stage: "DONE",
        result: { scenes: scenes.length },
        error: null,
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
        if (sessionId) this.sessionService.setStage(sessionId, "SPLIT_FAILED");
      } catch {}
    }
  }
}

module.exports = { StoryService };
