// src/image/ImageProvider.js
const https = require("https");
const { URL } = require("url");

const PROVIDER_VERSION = "imgprov_https_only_v3";

function httpsPostJson(urlStr, headers, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const body = JSON.stringify(bodyObj);

    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
        // 有些环境 TLS/连接很敏感，这里显式关掉 keepAlive，避免复用连接出幺蛾子
        agent: new https.Agent({ keepAlive: false }),
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (chunks += d));
        res.on("end", () => resolve({ status: res.statusCode || 0, text: chunks }));
      }
    );

    req.on("error", (e) => reject(e));
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" })));

    req.write(body);
    req.end();
  });
}

class ImageProvider {
  constructor() {
    this.apiKey = process.env.ARK_API_KEY || "";
    this.endpoint =
      (process.env.ARK_IMAGE_ENDPOINT || "https://ark.cn-beijing.volces.com/api/v3/images/generations").trim();

    this.model = (process.env.ARK_IMAGE_MODEL || "doubao-seedream-4-5-251128").trim();
    this.timeoutMs = Number(process.env.ARK_TIMEOUT_MS || 90000);

    this.version = PROVIDER_VERSION;
  }

  _assertEnv() {
    if (!this.apiKey) throw new Error(`${this.version}:image_config_missing:ARK_API_KEY`);
  }

  async generate({ prompt, images, size = "2K", watermark = true } = {}) {
    this._assertEnv();

    const p = String(prompt || "").trim();
    if (!p) throw new Error(`${this.version}:image_prompt_empty`);

    let imageField = undefined;
    if (Array.isArray(images)) {
      const arr = images.filter(Boolean).map(String);
      if (arr.length === 1) imageField = arr[0];
      else if (arr.length > 1) imageField = arr;
    } else if (typeof images === "string" && images.trim()) {
      imageField = images.trim();
    }

    const payload = {
      model: this.model,
      prompt: p,
      sequential_image_generation: "disabled",
      response_format: "url",
      size,
      stream: false,
      watermark: !!watermark,
    };
    if (imageField) payload.image = imageField;

    let r;
    try {
      r = await httpsPostJson(
        this.endpoint,
        { Authorization: `Bearer ${this.apiKey}` },
        payload,
        this.timeoutMs
      );
    } catch (e) {
      // ✅ 这里会拿到 ENOTFOUND / ECONNRESET / ETIMEDOUT 等真实原因
      const code = e?.code || "";
      const msg = e?.message || String(e);
      throw new Error(`${this.version}:image_https_failed:${code}:${msg}`);
    }

    const rawText = r.text || "";
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`${this.version}:image_http_${r.status}:${rawText.slice(0, 1200)}`);
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`${this.version}:image_bad_json:${rawText.slice(0, 300)}`);
    }

    const url =
      data?.data?.[0]?.url ||
      data?.images?.[0]?.url ||
      data?.output?.[0]?.url ||
      "";

    if (!url) throw new Error(`${this.version}:image_no_url:${rawText.slice(0, 500)}`);

    return { url: String(url), raw: data, providerVersion: this.version };
  }
}

module.exports = { ImageProvider };
