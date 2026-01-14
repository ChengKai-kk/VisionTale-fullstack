// src/voice/AsrProvider.js
const crypto = require("crypto");

class AsrProvider {
  constructor() {
    // 极速识别（flash）
    this.endpoint = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
  }

  _mustEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`missing_env:${name}`);
    return v;
  }

  _guessFormat(mimeType) {
    const m = (mimeType || "").toLowerCase();
    if (m.includes("wav")) return "wav";
    if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
    if (m.includes("ogg")) return "ogg";
    if (m.includes("webm")) return "webm"; // 先这么写；若服务端不支持 webm，我们再改前端录 ogg
    return "webm";
  }

  /**
   * 极速识别（JSON 方式：audio.data base64）
   * 目的：避免服务端把二进制当 JSON 解析导致 \x1a 报错
   */
  async recognizeFlashJson({ audioBase64DataOnly, mimeType }) {
    if (!audioBase64DataOnly || typeof audioBase64DataOnly !== "string") {
      throw new Error("missing_audio_base64");
    }

    const appId = this._mustEnv("VOLC_SPEECH_APP_ID");
    const accessKey = this._mustEnv("VOLC_SPEECH_ACCESS_KEY");
    const resourceId = this._mustEnv("ASR_RESOURCE_ID");

    const format = this._guessFormat(mimeType);

    const headers = {
      "Content-Type": "application/json",
      "X-Api-App-Id": appId,
      "X-Api-Access-Key": accessKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": crypto.randomUUID(),
      "X-Api-Sequence": "-1",
    };

    const body = {
      audio: {
        // 只传纯 base64（不要 data:xxx;base64, 前缀）
        data: audioBase64DataOnly,
        format,
      },
    };

    const resp = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`asr_http_${resp.status}:${text.slice(0, 800)}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`asr_invalid_json:${text.slice(0, 200)}`);
    }

    // 容错取文本
    const transcript =
      json?.result?.text ||
      json?.text ||
      json?.utterances?.[0]?.text ||
      json?.data?.result?.text ||
      "";

    if (!transcript) {
      throw new Error(`asr_no_transcript:${JSON.stringify(json).slice(0, 400)}`);
    }

    return { transcript, raw: json };
  }
}

module.exports = { AsrProvider };
