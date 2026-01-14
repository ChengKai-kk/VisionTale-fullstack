class MemorySessionStore {
  constructor({ ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.map = new Map(); // Map<sessionId, sessionObj>
  }

  _now() {
    return Date.now();
  }

  _computeExpiresAt(now) {
    return now + this.ttlMs;
  }

  _isExpired(sess, now) {
    const exp = sess?.expiresAt;
    return typeof exp === "number" && exp <= now;
  }

  /** 惰性清理：访问时顺便清理 */
  get(sessionId, { touch = true } = {}) {
    const now = this._now();
    const sess = this.map.get(sessionId);
    if (!sess) return null;

    if (this._isExpired(sess, now)) {
      this.map.delete(sessionId);
      return null;
    }

    if (touch) {
      const next = {
        ...sess,
        lastAccessAt: now,
        expiresAt: this._computeExpiresAt(now),
      };
      this.map.set(sessionId, next);
      return next;
    }

    return sess;
  }

  /** 创建（如果不存在） */
  createIfAbsent(sessionId) {
    const now = this._now();
    const existing = this.map.get(sessionId);
    if (existing && !this._isExpired(existing, now)) return existing;

    const sess = {
      sessionId,
      stage: "INIT",
      artifacts: {},
      createdAt: now,
      updatedAt: now,
      lastAccessAt: now,
      expiresAt: this._computeExpiresAt(now),
    };
    this.map.set(sessionId, sess);
    return sess;
  }

  /** 合并更新：写 artifacts / stage 等 */
  patch(sessionId, patch) {
    const now = this._now();
    const cur = this.map.get(sessionId);

    // 若不存在或已过期，则重新创建一个空 session 再 patch
    const base = (!cur || this._isExpired(cur, now)) ? this.createIfAbsent(sessionId) : cur;

    const next = {
      ...base,
      ...patch,
      artifacts: patch?.artifacts ? { ...base.artifacts, ...patch.artifacts } : base.artifacts,
      updatedAt: now,
      lastAccessAt: now, // 写入也算“活跃”
      expiresAt: this._computeExpiresAt(now),
    };

    this.map.set(sessionId, next);
    return next;
  }

  delete(sessionId) {
    return this.map.delete(sessionId);
  }

  /** 定时清理：扫一遍过期的 */
  sweepExpired() {
    const now = this._now();
    let removed = 0;
    for (const [sid, sess] of this.map.entries()) {
      if (this._isExpired(sess, now)) {
        this.map.delete(sid);
        removed += 1;
      }
    }
    return removed;
  }
}

module.exports = { MemorySessionStore };
