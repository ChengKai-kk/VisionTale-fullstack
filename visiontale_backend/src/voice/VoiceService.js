// src/voice/VoiceService.js
const { AsrProvider } = require("./AsrProvider");
const { LlmProvider } = require("./LlmProvider");
const { QwenTtsProvider } = require("./QwenTtsProvider");

function now() {
  return Date.now();
}

/**
 * 把 ASR 输出规范化为文本
 * - 兼容 string / { transcript } / { text } / 其它对象
 */
function normalizeAsrToText(asrResult) {
  if (typeof asrResult === "string") return asrResult.trim();

  if (asrResult && typeof asrResult === "object") {
    const t =
      (typeof asrResult.transcript === "string" && asrResult.transcript) ||
      (typeof asrResult.text === "string" && asrResult.text) ||
      (typeof asrResult.result?.text === "string" && asrResult.result.text) ||
      "";
    if (t && String(t).trim()) return String(t).trim();
    // 实在没字段，就兜底序列化（但尽量不要走到这里）
    return JSON.stringify(asrResult).slice(0, 2000);
  }

  return String(asrResult ?? "").trim();
}

/**
 * 确保 messages 里 content 全是 string（Ark 要求）
 * - 历史里如果混入了对象，强制转成 transcript 或 JSON 字符串
 */
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(Boolean)
    .map((m) => {
      const role = m?.role || "user";
      let content = m?.content;

      if (typeof content === "string") {
        content = content.trim();
      } else if (content && typeof content === "object") {
        // 优先用 transcript / text
        content =
          (typeof content.transcript === "string" && content.transcript) ||
          (typeof content.text === "string" && content.text) ||
          JSON.stringify(content);
      } else {
        content = String(content ?? "");
      }

      // Ark content 最终必须是 string 或 array-of-objects；这里统一用 string
      return { role, content: String(content).slice(0, 4000) };
    })
    .filter((m) => m.content && m.content.trim());
}

class VoiceService {
  constructor({ taskStore, sessionService }) {
    this.taskStore = taskStore;
    this.sessionService = sessionService;

    this.asr = new AsrProvider();
    this.llm = new LlmProvider();
    this.tts = new QwenTtsProvider();
  }

  async testTts(text) {
    return await this.tts.synthesize(String(text || "").slice(0, 800));
  }

  startAsrTask(taskId, { sessionId, audioBase64DataOnly, mimeType }) {
    setImmediate(async () => {
      try {
        this.taskStore.patch(taskId, {
          status: "RUNNING",
          progress: 5,
          stage: "ASR",
          updatedAt: now(),
        });

        const asrRet = await this.asr.recognizeFlashJson({
          audioBase64DataOnly,
          mimeType,
        });

        const userText = normalizeAsrToText(asrRet);

        this.sessionService.writeArtifact(sessionId, "voice.lastUser", {
          text: userText,
          // 可选：把 raw 存起来调试，但不要塞进 storyDialog.messages/LLM messages
          raw: asrRet && typeof asrRet === "object" ? asrRet : null,
          createdAt: now(),
        });

        this.sessionService.setStage(sessionId, "VOICE_ASR_DONE");

        this.taskStore.patch(taskId, {
          status: "DONE",
          progress: 100,
          stage: "DONE",
          result: { userText },
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
          this.sessionService.setStage(sessionId, "VOICE_FAILED");
        } catch {}
      }
    });
  }

  /**
   * ✅ ASR -> LLM(多轮) -> TTS
   */
  startDialogTask(taskId, { sessionId, audioBase64DataOnly, mimeType }) {
    setImmediate(async () => {
      try {
        this.taskStore.patch(taskId, {
          status: "RUNNING",
          progress: 5,
          stage: "ASR",
          updatedAt: now(),
        });

        // 1) ASR
        const asrRet = await this.asr.recognizeFlashJson({
          audioBase64DataOnly,
          mimeType,
        });
        const userText = normalizeAsrToText(asrRet);

        this.taskStore.patch(taskId, {
          progress: 35,
          stage: "LLM",
          asrText: userText,
          updatedAt: now(),
        });

        // 存一份 raw 便于调试，但不要进入 LLM messages
        this.sessionService.writeArtifact(sessionId, "voice.lastUser", {
          text: userText,
          raw: asrRet && typeof asrRet === "object" ? asrRet : null,
          createdAt: now(),
        });

        this.sessionService.setStage(sessionId, "VOICE_LLM_PENDING");

        // 2) LLM（多轮收集 storyReq）
        const sess = this.sessionService.get(sessionId) || this.sessionService.ensure(sessionId);
        const dialogNode = sess?.artifacts?.storyDialog || {};
        const reqNode = sess?.artifacts?.storyReq || {};

        // ✅ 历史消息强制清洗（content 必须是 string）
        const history = sanitizeMessages(dialogNode.messages || []);

        const systemPrompt = `
你是一个和小朋友聊天的故事小助手，你的任务是用 3~6 轮对话搞清楚他想要的故事。

规则：
- 每次回复尽量短（1~2 句话），并且【最多问 1 个问题】。
- 不要一次问很多选项，把问题说得很简单。
- 不要吓小朋友，不要暴力血腥，不要出现血、死亡、虐待等内容。
- 你需要逐步填充 storyReq：{genre, hero, setting, companion, obstacle, tone, ending, length, taboo}
- 你会看到当前已收集的信息 currentStoryReq，请在此基础上补全缺失字段。
- 如果信息已经够了（至少包含 genre/hero/setting/tone/ending），就进行一次“总结确认”，并把 done=true。

输出格式必须是 JSON（不要输出其它文本），形如：
{
  "say": "给小朋友听的话",
  "storyReq": { "genre": "...", "hero": "..." },
  "done": false
}

currentStoryReq:
${JSON.stringify(reqNode || {}, null, 2)}
        `.trim();

        const messages = sanitizeMessages([
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: userText }, // ✅ 一定是 string
        ]);

        const assistantRaw = await this.llm.chat({ messages });

        // 解析 JSON（容错：可能包 ```json）
        const extractJson = (s) => {
          const t = String(s || "").trim();
          const m = t.match(/\{[\s\S]*\}/);
          if (!m) throw new Error("llm_no_json");
          return JSON.parse(m[0]);
        };

        let parsed;
        try {
          parsed = extractJson(assistantRaw);
        } catch {
          parsed = { say: String(assistantRaw || "").trim(), storyReq: {}, done: false };
        }

        const assistantText = String(parsed.say || "").trim();
        const nextReq = parsed.storyReq || {};
        const done = !!parsed.done;

        // 写回 session：对话历史（只存纯文本）+ 结构化需求
        this.sessionService.appendMessages(
          sessionId,
          "storyDialog",
          [
            { role: "user", content: userText },
            { role: "assistant", content: assistantText },
          ],
          { max: 24 }
        );

        this.sessionService.writeArtifact(sessionId, "storyReq", {
          ...(reqNode || {}),
          ...(nextReq || {}),
          done,
          updatedAt: now(),
        });

        this.sessionService.setStage(sessionId, done ? "STORY_REQ_DONE" : "STORY_REQ_COLLECTING");

        this.taskStore.patch(taskId, {
          progress: 65,
          stage: "TTS",
          assistantText,
          updatedAt: now(),
        });

        this.sessionService.writeArtifact(sessionId, "voice.lastAssistant", {
          text: assistantText,
          createdAt: now(),
        });

        this.sessionService.setStage(sessionId, "VOICE_TTS_PENDING");

        // 3) TTS
        const ttsRet = await this.tts.synthesize(assistantText);

        this.sessionService.writeArtifact(sessionId, "voice.lastAssistantAudio", {
          url: ttsRet.url,
          mimeType: ttsRet.mimeType,
          format: ttsRet.format,
          createdAt: now(),
          expiresAt: ttsRet.expiresAt ?? null,
        });

        this.sessionService.setStage(sessionId, "VOICE_DONE");

        this.taskStore.patch(taskId, {
          status: "DONE",
          progress: 100,
          stage: "DONE",
          result: {
            userText,
            assistantText,
            audio: { mimeType: ttsRet.mimeType, format: ttsRet.format },
          },
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
          this.sessionService.setStage(sessionId, "VOICE_FAILED");
        } catch {}
      }
    });
  }
}

module.exports = { VoiceService };
