// src/voice/QwenTtsProvider.js

class QwenTtsProvider {
  constructor() {
    this.apiKey = process.env.DASHSCOPE_API_KEY || "";
    this.endpoint =
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
    this.model = "qwen3-tts-flash";
    this.timeoutMs = Number(process.env.TTS_TIMEOUT_MS || 30000);

    // ✅ DashScope 示例里出现的 voice（最稳的就是 Cherry）
    // 你后面如果确认了更多可用 voice，再往里加
    this.allowedVoices = new Set(["Cherry"]);
    this.defaultVoice = "Cherry";

    // language_type 也做个兜底
    this.defaultLanguageType = "Chinese";
  }

  _assertEnv() {
    if (!this.apiKey) {
      throw new Error("tts_config_missing:DASHSCOPE_API_KEY");
    }
  }

  _pickVoice() {
    // 你如果环境变量里还保留了以前火山的 speaker，会导致 400
    // ✅ 这里强制白名单 + fallback
    const v = (process.env.TTS_SPEAKER || "").trim();
    if (this.allowedVoices.has(v)) return v;

    // 如果你想保留“随便填也能用”的体验，这里直接 fallback
    return this.defaultVoice;
  }

  /**
   * @param {string} text
   * @returns {Promise<{type:'url', url:string, mimeType:string, format:string, expiresAt?:number}>}
   */
  async synthesize(text) {
    this._assertEnv();

    const inputText = String(text || "").trim();
    if (!inputText) throw new Error("tts_empty_text");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const voice = this._pickVoice();

      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: {
            text: inputText,
            voice, // ✅ 永远是 DashScope 支持的 voice（Cherry）
            language_type: this.defaultLanguageType,
          },
        }),
        signal: controller.signal,
      });

      const raw = await res.text();

      if (!res.ok) {
        throw new Error(`dashscope_tts_http_${res.status}:${raw.slice(0, 1200)}`);
      }

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`dashscope_tts_bad_json:${raw.slice(0, 300)}`);
      }

      const audio = data?.output?.audio;
      const url = audio?.url;

      if (!url) {
        throw new Error(`dashscope_tts_no_url:${raw.slice(0, 800)}`);
      }

      return {
        type: "url",
        url,
        mimeType: "audio/wav",
        format: "wav",
        expiresAt: audio?.expires_at,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { QwenTtsProvider };
