import assert from 'node:assert/strict'
import { defineConfig, devices } from '@playwright/test'


const RETRIES_CI = 2
const URL_DEV = 'http://127.0.0.1:1420'
const WEB_SERVER_TIMEOUT_MILLISECONDS = 120_000


export default defineConfig({
    testDir: 'tests/e2e',
    fullyParallel: true,
    forbidOnly: ci_running(),
    retries: ci_running() ? RETRIES_CI : 0,
    reporter: ci_running() ? 'github' : 'list',
    use: {
        baseURL: URL_DEV,
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        command: 'bun run dev --host 127.0.0.1',
        url: URL_DEV,
        reuseExistingServer: !ci_running(),
        timeout: WEB_SERVER_TIMEOUT_MILLISECONDS,
    },
})

function ci_running(): boolean {
    const marker = process.env['CI'] ?? ''

    assert(typeof marker === 'string')
    assert(!marker.includes('\n'))

    return marker.length > 0
}
