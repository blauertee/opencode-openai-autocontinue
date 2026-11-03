// A minimal stand-in for the OpenCode 2 plugin context: only the pieces the
// plugin touches, recording what it does.

export function createFakeContext({ options = {}, directory = "/work", sessions = {}, credential, storage = new Map() } = {}) {
  const hooks = new Map()
  const queue = []
  let wake
  const calls = { synthetic: [], interrupt: [] }
  const commands = []
  const ctx = {
    options,
    location: { directory },
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => void storage.set(key, structuredClone(value)),
      remove: async (key) => void storage.delete(key),
      scan: async ({ prefix }) => ({
        entries: [...storage.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    integration: {
      connection: {
        active: async (id) => (credential && id === "openai" ? { id: "conn" } : undefined),
        resolve: async () => credential,
      },
    },
    command: {
      transform: async (callback) => callback({ add: (definition) => commands.push(definition) }),
    },
    session: {
      hook: async (name, callback) => {
        hooks.set(name, [...(hooks.get(name) ?? []), callback])
      },
      get: async ({ sessionID }) => {
        const value = sessions[sessionID]
        if (!value) throw new Error("not found")
        return value
      },
      synthetic: async (input) => {
        calls.synthetic.push(input)
        return { id: "syn" }
      },
      interrupt: async (input) => void calls.interrupt.push(input),
    },
    event: {
      subscribe: ({ signal } = {}) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) {
            if (queue.length) {
              yield queue.shift()
              continue
            }
            await new Promise((resolve) => {
              wake = resolve
              signal?.addEventListener("abort", resolve, { once: true })
            })
          }
        },
      }),
    },
  }
  return {
    ctx,
    calls,
    commands,
    storage,
    async trigger(name, event) {
      for (const callback of hooks.get(name) ?? []) await callback(event)
      return event
    },
    async emit(type, data, location = { directory }) {
      queue.push({ type, data, location })
      wake?.()
      await settle()
    },
  }
}

export const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}
