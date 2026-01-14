// src/voice/TtsProvider.js
// 单向流式 HTTP v3（大模型语音合成）
// 文档：/api/v3/tts/unidirectional
// 关键鉴权：X-Api-App-Id / X-Api-Access-Key / X-Api-Resource-Id(seed-tts-2.0)

class TtsProvider {
  constructor() {
    this.endpoint =
      process.env.VOLC_TTS_ENDPOINT ||
      "https://openspeech.bytedance.com/api/v3/tts/unidirectional";

    this.appId = process.env.VOLC_SPEECH_APP_ID || "";
    this.accessKey = process.env.VOLC_SPEECH_ACCESS_KEY || "";

    // ✅ 关键：默认值给 seed-tts-2.0，避免落到 volc.seedtts.default 这种不匹配默认
    this.resourceId = process.env.TTS_RESOURCE_ID || "seed-tts-2.0";

    // ✅ speaker 必填（从控制台音色列表复制）
    this.speaker = process.env.TTS_SPEAKER || "";

    // 输出格式：mp3/ogg_opus/pcm（文档默认 mp3）
    this.format = process.env.TTS_AUDIO_FORMAT || "mp3";
    this.sampleRate = Number(process.env.TTS_SAMPLE_RATE || 24000);

    // 超时
    this.timeoutMs = Number(process.env.TTS_TIMEOUT_MS || 30000);
  }

  _checkEnv() {
    const miss = [];
    if (!this.appId) miss.push("VOLC_SPEECH_APP_ID");
    if (!this.accessKey) miss.push("VOLC_SPEECH_ACCESS_KEY");
    if (!this.resourceId) miss.push("TTS_RESOURCE_ID");
    if (!this.speaker) miss.push("TTS_SPEAKER");
    if (miss.length) {
      throw new Error(`tts_config_missing: ${miss.join(", ")}`);
    }
  }

  async synthesizeMp3Base64(text, { requestId } = {}) {
    this._checkEnv();
    if (!text || !String(text).trim()) throw new Error("tts_empty_text");

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = {
        "Content-Type": "application/json",
        "X-Api-App-Id": this.appId,
        "X-Api-Access-Key": this.accessKey,
        "X-Api-Resource-Id": this.resourceId,
      };
      if (requestId) headers["X-Api-Request-Id"] = requestId;

      const payload = {
        user: { uid: "visiontale" },
        namespace: "BidirectionalTTS",
        req_params: {
          text: String(text),
          speaker: this.speaker,
          audio_params: {
            format: this.format, // mp3 / ogg_opus / pcm
            sample_rate: this.sampleRate,
          },
        },
      };

      const res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await safeReadText(res);
        throw new Error(`tts_http_${res.status}:${errText}`);
      }

      // 单向流式：服务端会不断返回 JSON（每行一个 JSON）
      // 我们把所有音频片段的 base64 拼起来（mp3 切片直接拼即可）
      const reader = res.body?.getReader?.();
      if (!reader) {
        const t = await res.text();
        throw new Error(`tts_no_stream:${t || "empty_body"}`);
      }

      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let audioBase64Joined = "";
      let doneFlag = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 按行切（服务端一般是 \n 分隔 JSON）
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);

          if (!line) continue;

          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            // 不是完整 JSON 就先跳过（也可能是 chunk 边界导致）
            continue;
          }

          // 常见结构：{ event, data: { audio: { data: "base64..." }, ... } }
          const b64 =
            obj?.data?.audio?.data ||
            obj?.audio?.data ||
            obj?.data?.data ||
            "";

          if (b64) audioBase64Joined += b64;

          // 有些实现会在结束时给 done / is_end
          if (obj?.data?.is_end === true || obj?.is_end === true) {
            doneFlag = true;
          }
        }
      }

      if (!audioBase64Joined) {
        throw new Error(`tts_empty_audio:done=${doneFlag}`);
      }

      return {
        format: this.format,
        sampleRate: this.sampleRate,
        audioBase64: audioBase64Joined,
      };
    } finally {
      clearTimeout(t);
    }
  }
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

module.exports = { TtsProvider };
