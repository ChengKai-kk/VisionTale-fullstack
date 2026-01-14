class MemoryTaskStore {
  constructor() {
    this.map = new Map();
  }

  create(task) {
    this.map.set(task.taskId, task);
    return task;
  }

  get(taskId) {
    return this.map.get(taskId) || null;
  }

  patch(taskId, patch) {
    const cur = this.map.get(taskId);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.map.set(taskId, next);
    return next;
  }

  delete(taskId) {
    return this.map.delete(taskId);
  }
}

module.exports = { MemoryTaskStore };
