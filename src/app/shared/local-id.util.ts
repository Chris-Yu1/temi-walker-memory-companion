export function createLocalId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  const randomPart = Math.random().toString(36).slice(2, 12);
  return `photo-${Date.now().toString(36)}-${randomPart}`;
}
