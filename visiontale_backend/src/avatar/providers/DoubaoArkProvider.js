class DoubaoArkProvider {
  constructor() {
    this.baseUrl = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
    this.apiKey = process.env.ARK_API_KEY;
    this.model = process.env.ARK_IMAGE_MODEL || "doubao-seedream-4-5-251128";
    if (!this.apiKey) throw new Error("Missing env ARK_API_KEY");
  }

  /**
   * @param {{ image: string, prompt: string, size?: string }} input
   * image: supports URL or data:image/...;base64,...  (官方支持) :contentReference[oaicite:2]{index=2}
   */
  async stylize({ image, prompt, size = "2K" }) {
    const url = `${this.baseUrl}/images/generations`;

    const payload = {
      model: this.model,
      prompt,
      image,
      sequential_image_generation: "disabled",
      response_format: "url", // 24h 临时链接（你想要的）
      size,
      stream: false,
      watermark: true
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const text = await r.text();
    if (!r.ok) {
      throw new Error(`Ark error ${r.status}: ${text}`);
    }

    const data = JSON.parse(text);
    const outUrl = data?.data?.[0]?.url;
    if (!outUrl) throw new Error(`Ark response missing data[0].url: ${text}`);
    return { avatarUrl: outUrl };
  }
}

module.exports = { DoubaoArkProvider };
