// src/voice/LlmProvider.js

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isAbortError(e) {
  if (!e) return false;
  if (e.name === "AbortError") return true;
  const msg = String(e.message || "");
  // undici/node-fetch 常见提示
  return msg.includes("aborted") || msg.includes("AbortError");
}

function safeSlice(s, n) {
  const str = typeof s === "string" ? s : String(s || "");
  return str.length > n ? str.slice(0, n) : str;
}

class LlmProvider {
  constructor() {
    this.apiKey = process.env.ARK_API_KEY || "";
    this.endpoint =
      process.env.ARK_CHAT_ENDPOINT ||
      "https://ark.cn-beijing.volces.com/api/v3/chat/completions";

    // 默认模型（允许 env 覆盖）
    this.model = process.env.ARK_LLM_MODEL || "doubao-seed-1-6-lite-251015";

    // ⚠️ 关键：故事生成更慢，默认超时改为 120s（你也可以 env 覆盖）
    this.timeoutMs = Number(process.env.ARK_TIMEOUT_MS || 120000);

    // 默认重试 1 次（网络抖动 / 429 / 5xx / timeout 有用）
    this.maxRetry = Number(process.env.ARK_LLM_MAX_RETRY || 1);
  }

  _assertEnv() {
    if (!this.apiKey) throw new Error("llm_config_missing:ARK_API_KEY");
  }

  /**
   * 统一对外：chat
   * @param {{
   *  messages?:Array<{role:string,content:any}>,
   *  sessionId?:string,
   *  userText?:string,
   *  timeoutMs?:number,
   *  temperature?:number,
   *  maxRetry?:number
   * }} param0
   * @returns {Promise<string>} assistantText
   */
  async chat({ messages, sessionId, userText, timeoutMs, temperature, maxRetry } = {}) {
    this._assertEnv();

    // ✅ 新版优先使用 messages（多轮对话）。兼容 userText 单轮。
    let finalMessages = Array.isArray(messages) ? messages : null;
    if (!finalMessages) {
      const text = String(userText || "").trim();
      if (!text) throw new Error("llm_empty_userText");
      finalMessages = [
        {
          role: "system",
          content:
            "你是一个与小朋友对话的故事助手。用简短、友好、清晰的中文回答。必要时先问一个澄清问题。",
        },
        { role: "user", content: text },
      ];
    }

    const useTimeoutMs =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.round(timeoutMs)
        : this.timeoutMs;

    const retryN =
      typeof maxRetry === "number" && Number.isFinite(maxRetry) && maxRetry >= 0
        ? Math.round(maxRetry)
        : this.maxRetry;

    const payload = {
      model: this.model,
      messages: finalMessages,
      temperature: typeof temperature === "number" ? temperature : 0.7,
    };

    let lastErr = null;

    for (let attempt = 0; attempt <= retryN; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), useTimeoutMs);

      try {
        const res = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        const raw = await res.text().catch(() => "");

        if (!res.ok) {
          // Ark 会把错误放在 body 里，这里截断，避免 taskStore 太大
          const err = new Error(`llm_http_${res.status}:${safeSlice(raw, 1200)}`);
          err.httpStatus = res.status;
          err.raw = raw;

          // 401/403/400 这种一般不可重试，直接抛
          if (res.status === 400 || res.status === 401 || res.status === 403) {
            throw err;
          }

          // 429/5xx 可重试
          throw err;
        }

        let data;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          throw new Error(`llm_bad_json:${safeSlice(raw, 600)}`);
        }

        // 兼容 content 为 string 或数组的情况
        let assistant =
          data?.choices?.[0]?.message?.content ??
          data?.choices?.[0]?.message?.content?.[0]?.text ??
          "";

        assistant = typeof assistant === "string" ? assistant : JSON.stringify(assistant || "");

        if (!assistant || !assistant.trim()) {
          throw new Error(`llm_empty_response:${safeSlice(raw, 800)}`);
        }

        return assistant.trim();
      } catch (e) {
        // 统一把 abort 转成明确 timeout
        if (isAbortError(e)) {
          lastErr = new Error(`llm_timeout_${useTimeoutMs}ms`);
        } else {
          lastErr = e;
        }

        // 不可重试的情况：鉴权/参数等
        const httpStatus = lastErr?.httpStatus;
        const msg = String(lastErr?.message || "");

        const nonRetryable =
          httpStatus === 400 ||
          httpStatus === 401 ||
          httpStatus === 403 ||
          msg.startsWith("llm_config_missing") ||
          msg.startsWith("llm_empty_userText") ||
          msg.startsWith("llm_bad_json");

        if (nonRetryable) break;

        // 还有重试次数 → 退避一下再试
        if (attempt < retryN) {
          await sleep(500 + attempt * 700);
          continue;
        }

        break;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastErr || new Error("llm_failed");
  }
}

module.exports = { LlmProvider };
