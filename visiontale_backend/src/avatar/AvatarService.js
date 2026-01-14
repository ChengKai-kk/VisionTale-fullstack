const { ProviderFactory } = require("./providers/ProviderFactory");

const TASK_TTL_MS = 60 * 60 * 1000; // 1 hour

class AvatarService {
  constructor({ taskStore, sessionService }) {
    this.taskStore = taskStore;
    this.sessionService = sessionService;
    this.providerFactory = new ProviderFactory();
  }

  startTask(taskId, input) {
    setTimeout(() => this._run(taskId, input), 10);
  }

  async _run(taskId, input) {
    const sessionId = input?.sessionId;

    try {
      this.taskStore.patch(taskId, { status: "RUNNING", progress: 10 });
      if (sessionId) this.sessionService?.setStage(sessionId, "AVATAR_RUNNING");

      const provider = this.providerFactory.get("doubao");
      const prompt = buildPrompt(input.styleId);

      this.taskStore.patch(taskId, { progress: 35 });

      const { avatarUrl } = await provider.stylize({
        image: input.imageBase64, // data:image/...;base64,...
        prompt,
        size: input.size || "2K",
      });

      const expiresAt = Date.now() + TASK_TTL_MS;

      this.taskStore.patch(taskId, {
        status: "DONE",
        progress: 100,
        result: { avatarUrl },
        error: null,
        expiresAt,
      });

      // ✅ 关键：把头像结果写入 session（后续其他节点复用同一套接口）
      if (sessionId && this.sessionService) {
        this.sessionService.ensure(sessionId);
        this.sessionService.writeArtifact(sessionId, "avatar", {
          url: avatarUrl,
          styleId: input.styleId || "comic",
          size: input.size || "2K",
        });
        this.sessionService.setStage(sessionId, "AVATAR_DONE");
      }

      // ✅ 释放 base64 引用
      input.imageBase64 = null;

      // ✅ 1h 后删除 task（防止 Map 无限增长）
      this._scheduleDelete(taskId);
    } catch (e) {
      const errMsg = String(e?.stack || e);
      const expiresAt = Date.now() + TASK_TTL_MS;

      this.taskStore.patch(taskId, {
        status: "FAILED",
        progress: 100,
        error: errMsg,
        expiresAt,
      });

      if (sessionId && this.sessionService) {
        this.sessionService.ensure(sessionId);
        this.sessionService.setStage(sessionId, "AVATAR_FAILED");
      }

      if (input) input.imageBase64 = null;
      this._scheduleDelete(taskId);
    }
  }

  _scheduleDelete(taskId) {
    setTimeout(() => {
      if (typeof this.taskStore.delete === "function") this.taskStore.delete(taskId);
    }, TASK_TTL_MS);
  }
}

function buildPrompt(styleId) {
  if (styleId === "comic") {
    return "将参考照片中的人物转换为高质量漫画头像，保留人物五官特征，线稿干净清晰，柔和配色，背景简洁纯色，画面干净不杂乱。";
  }
  return "将参考照片中的人物风格化为卡通头像，保留人物特征，背景简洁，整体清晰自然。";
}

module.exports = { AvatarService };
