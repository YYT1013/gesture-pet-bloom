export class EventQueue {
  constructor({ send, storage = null, key = "gesture-pet:events", batchSize = 20, maxItems = 200 } = {}) {
    if (typeof send !== "function") throw new TypeError("EventQueue requires a send function");
    this.send = send;
    this.storage = storage;
    this.key = key;
    this.batchSize = Math.max(1, batchSize);
    this.maxItems = Math.max(1, maxItems);
    this.items = this.#restore().slice(-this.maxItems);
    this.flushing = null;
  }

  #restore() {
    if (!this.storage) return [];
    try {
      const parsed = JSON.parse(this.storage.getItem(this.key) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  #persist() {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.items));
    } catch {
      // Storage can be unavailable in private browsing; in-memory queue still works.
    }
  }

  enqueue(event) {
    this.items.push(event);
    if (this.items.length > this.maxItems) this.items.splice(0, this.items.length - this.maxItems);
    this.#persist();
    return this.items.length >= this.batchSize ? this.flush() : Promise.resolve({ ok: true, sent: 0 });
  }

  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.items.length) return { ok: true, sent: 0 };

    this.flushing = (async () => {
      const batch = this.items.slice(0, this.batchSize);
      try {
        await this.send(batch);
        this.items.splice(0, batch.length);
        this.#persist();
        return { ok: true, sent: batch.length };
      } catch (error) {
        this.#persist();
        return { ok: false, sent: 0, error };
      } finally {
        this.flushing = null;
      }
    })();

    return this.flushing;
  }

  snapshot() {
    return this.items.slice();
  }
}
