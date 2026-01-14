// src/video/VideoService.js
const { VideoProvider } = require("./VideoProvider");

function now() {
  return Date.now();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function sortByOrder(a, b) {
  return Number(a?.order || 0) - Number(b?.order || 0);
}
function clampText(s, max = 260) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max);
}

class VideoService {
  constructor({ taskStore, sessionService }) {
    this.taskStore = taskStore;
    this.sessionService = sessionService;
    this.provider = new VideoProvider();
  }

  startGenerateClipsTask(taskId, input) {
    setImmediate(() => this._run(taskId, input));
  }

  _buildClipPlan(sess) {
    const scenes = Array.isArray(sess?.artifacts?.scenes?.items) ? sess.artifacts.scenes.items : [];
    const images = Array.isArray(sess?.artifacts?.sceneImages?.items)
      ? sess.artifacts.sceneImages.items
      : [];

    const sceneById = new Map(scenes.map((s) => [s.id, s]));
    const sortedImages = images.slice().sort(sortByOrder);

    const clips = [];
    for (const img of sortedImages) {
      if (!img?.imageUrl) continue;

      const sceneId = img.sceneId;
      const scene = sceneById.get(sceneId);

      const narration =
        (scene && (scene.narration || scene.sceneText || scene.sceneTitle)) ||
        img.caption ||
        sess?.artifacts?.story?.title ||
        "一段温暖的童话故事";

      clips.push({
        order: Number(img.order || 0),
        sceneId,
        imageUrl: img.imageUrl,
        narration: String(narration || "").trim(),
      });
    }
    return clips;
  }

  async _run(taskId, input) {
    const sessionId = input?.sessionId;
    const clipDuration = Math.max(1, Math.min(10, Number(input?.clipDuration || 5)));
    const watermark = input?.watermark !== false;

    try {
      this.taskStore.patch(taskId, {
        status: "RUNNING",
        progress: 5,
        stage: "LOAD_SESSION",
        updatedAt: now(),
      });

      const sess = this.sessionService.get(sessionId);
      if (!sess) throw new Error("session_not_found");

      const clips = this._buildClipPlan(sess);
      const N = clips.length;
      if (!N) throw new Error("no_scene_images");

      this.sessionService.setStage(sessionId, "VIDEO_RUNNING");

      // 初始化 artifacts
      this.sessionService.writeArtifact(sessionId, "video", {
        status: "running",
        clipCount: N,
        succeededCount: 0,
        failedCount: 0,
        finalVideoUrl: "", // 情况1：不合成，保持空
        updatedAt: now(),
        createdAt: now(),
      });
      this.sessionService.writeArtifact(sessionId, "videoClips", {
        items: [],
        source: "ark_i2v",
        updatedAt: now(),
        createdAt: now(),
      });

      const results = [];

      for (let i = 0; i < N; i++) {
        const c = clips[i];
        const promptText = `${clampText(c.narration, 260)} --duration ${clipDuration} --camerafixed false --watermark ${
          watermark ? "true" : "false"
        }`;

        // 写入 creating
        results[i] = {
          order: c.order,
          sceneId: c.sceneId,
          imageUrl: c.imageUrl,
          promptText,
          arkTaskId: "",
          status: "creating", // creating/polling/succeeded/failed
          videoUrl: "",
          duration: clipDuration,
          updatedAt: now(),
          createdAt: now(),
        };
        this.sessionService.writeArtifact(sessionId, "videoClips", {
          items: results,
          source: "ark_i2v",
          updatedAt: now(),
          createdAt: sess?.artifacts?.videoClips?.createdAt || now(),
        });

        // create
        this.taskStore.patch(taskId, {
          stage: `CREATE_${i + 1}/${N}`,
          progress: 10 + Math.floor((i / N) * 70),
          updatedAt: now(),
        });

        const created = await this.provider.createI2VTask({ promptText, imageUrl: c.imageUrl });
        results[i].arkTaskId = created.arkTaskId;
        results[i].status = "polling";
        results[i].updatedAt = now();

        this.sessionService.writeArtifact(sessionId, "videoClips", {
          items: results,
          source: "ark_i2v",
          updatedAt: now(),
          createdAt: sess?.artifacts?.videoClips?.createdAt || now(),
        });

        // poll
        const start = Date.now();
        const timeoutMs = Number(process.env.VIDEO_POLL_TIMEOUT_MS || 12 * 60 * 1000);
        const intervalMs = Number(process.env.VIDEO_POLL_INTERVAL_MS || 2500);

        while (true) {
          if (Date.now() - start > timeoutMs) {
            throw new Error(`clip_timeout:${created.arkTaskId}`);
          }

          const last = await this.provider.getTask(created.arkTaskId);
          const st = String(last?.status || "").toLowerCase();

          if (st === "succeeded") {
            const videoUrl = String(last?.content?.video_url || "").trim();
            if (!videoUrl) throw new Error(`clip_no_video_url:${created.arkTaskId}`);

            results[i].status = "succeeded";
            results[i].videoUrl = videoUrl;
            results[i].updatedAt = now();

            const succeededCount = results.filter((x) => x?.status === "succeeded").length;
            this.sessionService.writeArtifact(sessionId, "video", {
              status: succeededCount === N ? "clips_done" : "running",
              clipCount: N,
              succeededCount,
              failedCount: 0,
              finalVideoUrl: "",
              updatedAt: now(),
              createdAt: sess?.artifacts?.video?.createdAt || now(),
            });

            this.sessionService.writeArtifact(sessionId, "videoClips", {
              items: results,
              source: "ark_i2v",
              updatedAt: now(),
              createdAt: sess?.artifacts?.videoClips?.createdAt || now(),
            });

            break;
          }

          if (st === "failed" || st === "error" || st === "cancelled") {
            throw new Error(`clip_failed:${created.arkTaskId}:${st}`);
          }

          await sleep(intervalMs);
        }
      }

      this.sessionService.setStage(sessionId, "VIDEO_DONE");

      this.taskStore.patch(taskId, {
        status: "SUCCEEDED",
        progress: 100,
        stage: "DONE",
        result: { clipCount: N },
        updatedAt: now(),
      });
    } catch (e) {
      const msg = e?.message || String(e);
      this.sessionService.writeArtifact(sessionId, "video", {
        status: "failed",
        error: msg,
        updatedAt: now(),
      });
      this.sessionService.setStage(sessionId, "VIDEO_FAILED");
      this.taskStore.patch(taskId, {
        status: "FAILED",
        stage: "ERROR",
        error: msg,
        updatedAt: now(),
      });
    }
  }
}

module.exports = { VideoService };
