import assert from 'node:assert/strict'
import { defineConfig, devices } from '@playwright/test'


const TEST_TIMEOUT_MILLISECONDS = 240_000


export default defineConfig({
    testDir: 'tests/world',
    forbidOnly: ci_running(),
    fullyParallel: false,
    reporter: ci_running() ? 'github' : 'list',
    retries: 0,
    timeout: TEST_TIMEOUT_MILLISECONDS,
    workers: 1,
    use: {
        trace: 'retain-on-failure',
    },
    projects: [
        {
            name: 'website',
            testMatch: 'website.spec.ts',
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'app',
            testMatch: 'app.spec.ts',
        },
    ],
})

function ci_running(): boolean {
    const marker = process.env['CI'] ?? ''

    assert(typeof marker === 'string')
    assert(!marker.includes('\n'))

    return marker.length > 0
}
