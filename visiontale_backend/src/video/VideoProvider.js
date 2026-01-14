// src/video/VideoProvider.js
const https = require("https");
const { URL } = require("url");

function httpsJson(method, urlStr, headers, bodyObj, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const body = bodyObj ? JSON.stringify(bodyObj) : "";

    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(bodyObj ? { "Content-Length": Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (chunks += d));
        res.on("end", () => {
          const status = res.statusCode || 0;
          let json = null;
          try {
            json = chunks ? JSON.parse(chunks) : null;
          } catch {}
          resolve({ status, text: chunks, json });
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("ETIMEDOUT")));
    if (bodyObj) req.write(body);
    req.end();
  });
}

class VideoProvider {
  constructor() {
    this.base = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
    this.apiKey = process.env.ARK_API_KEY || "";
    this.model = process.env.ARK_VIDEO_MODEL || "doubao-seedance-1-5-pro-251215";
  }

  _headers() {
    if (!this.apiKey) throw new Error("missing_ARK_API_KEY");
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  async createI2VTask({ promptText, imageUrl }) {
    const url = `${this.base}/contents/generations/tasks`;
    const body = {
      model: this.model,
      content: [
        { type: "text", text: String(promptText || "").slice(0, 4000) },
        { type: "image_url", image_url: { url: String(imageUrl || "") } },
      ],
    };

    const r = await httpsJson("POST", url, this._headers(), body, 120000);
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`ark_video_create_failed:${r.status}:${r.text || ""}`);
    }
    const id = r.json?.id;
    if (!id) throw new Error(`ark_video_create_no_id:${r.text || ""}`);
    return { arkTaskId: id };
  }

  async getTask(arkTaskId) {
    const url = `${this.base}/contents/generations/tasks/${encodeURIComponent(String(arkTaskId))}`;
    const r = await httpsJson("GET", url, this._headers(), null, 60000);
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`ark_video_get_failed:${r.status}:${r.text || ""}`);
    }
    return r.json || null;
  }
}

module.exports = { VideoProvider };
