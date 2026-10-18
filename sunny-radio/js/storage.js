// localStorage wrapper that never throws (storage can be blocked or cleared).

export function createStorage(prefix = 'sunny.') {
  return {
    get(key) {
      try {
        const v = localStorage.getItem(prefix + key);
        return v == null ? null : JSON.parse(v);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(prefix + key, JSON.stringify(value));
      } catch {
        /* full or blocked; carry on */
      }
    },
  };
}

export function memoryStorage() {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
    set: (k, v) => m.set(k, JSON.stringify(v)),
  };
}
