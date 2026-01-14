class SessionService {
  constructor({ sessionStore }) {
    this.sessionStore = sessionStore;
  }

  /** 读取并 touch（用于“长时间不查就干掉”的策略） */
  get(sessionId) {
    return this.sessionStore.get(sessionId, { touch: true });
  }

  /** 确保存在 */
  ensure(sessionId) {
    return this.sessionStore.createIfAbsent(sessionId);
  }

  /**
   * 写入某个节点的最终产物（可扩展通用接口）
   * namespace: 'avatar' | 'voice' | 'story' | 'scenes' | ...
   * data: 结构化结果（不要塞 base64 / 大二进制）
   */
  writeArtifact(sessionId, namespace, data) {
    if (!sessionId) throw new Error("missing_sessionId");
    if (!namespace) throw new Error("missing_namespace");

    const now = Date.now();
    const patch = {
      artifacts: {
        [namespace]: {
          ...(data || {}),
          createdAt: data?.createdAt || now,
        },
      },
    };

    return this.sessionStore.patch(sessionId, patch);
  }

  /**
   * 追加对话 messages（用于多轮对话）。
   * - 会自动保留最近 max 条
   * - 写入位置：artifacts[namespace].messages
   */
  appendMessages(sessionId, namespace, newMessages, { max = 24 } = {}) {
    if (!sessionId) throw new Error("missing_sessionId");
    if (!namespace) throw new Error("missing_namespace");

    // 先确保 session 存在
    this.ensure(sessionId);

    const sess = this.get(sessionId);
    const oldNode = sess?.artifacts?.[namespace] || {};
    const oldMsgs = Array.isArray(oldNode.messages) ? oldNode.messages : [];
    const addMsgs = Array.isArray(newMessages) ? newMessages : [];

    const merged = [...oldMsgs, ...addMsgs].filter(Boolean).slice(-Number(max) || 24);

    return this.writeArtifact(sessionId, namespace, {
      ...oldNode,
      messages: merged,
      updatedAt: Date.now(),
    });
  }

  

  /** 更新 stage（可选，但后面你会需要） */
  setStage(sessionId, stage) {
    return this.sessionStore.patch(sessionId, { stage });
  }
}

module.exports = { SessionService };
