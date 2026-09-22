// Test environment setup.
//
// Node 22.4+ (we run Node 26) ships a built-in experimental Web Storage global.
// Without `--localstorage-file` it exposes `globalThis.localStorage` as an
// accessor that returns `undefined`, and that dead accessor shadows the
// `localStorage` jsdom would otherwise provide — so tests that touch
// localStorage/sessionStorage see `undefined`. Install a real in-memory Web
// Storage implementation on the global to restore browser-like behavior.

class MemoryStorage implements Storage {
  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }

  setItem(key: string, value: string): void {
    this.store.set(String(key), String(value))
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }
}

function installStorage(name: 'localStorage' | 'sessionStorage'): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  // Only override when the global is missing or non-functional (the Node
  // built-in returns undefined). A working jsdom Storage is left untouched.
  if (descriptor && (descriptor.value as Storage | undefined)?.setItem) return
  Object.defineProperty(globalThis, name, {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
    enumerable: true,
  })
}

installStorage('localStorage')
installStorage('sessionStorage')
