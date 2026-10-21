import { afterEach } from "vitest"

// Env-dependent modules (config.ts, index.ts) and vi.doMock-based module
// re-imports (tracker-gate.test.ts) require a clean module registry per test.
afterEach(() => {
    vi.resetModules()
})
