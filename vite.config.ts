import assert from 'node:assert/strict'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
import type { ServerOptions } from 'vite'


const CHUNK_SIZE_WARNING_KILOBYTES = 1_024
const HOST_LENGTH_MAX = 253
const MODULE_ID_LENGTH_MAX = 4_096
const PORT = 1_420
const PORT_HMR = 1_421


export default defineConfig({
    plugins: [vue(), tailwindcss()],
    resolve: {
        dedupe: [
            'prosemirror-model',
            'prosemirror-state',
            'prosemirror-transform',
            'prosemirror-view',
        ],
    },
    clearScreen: false,
    test: {
        environment: 'happy-dom',
        include: ['tests/unit/**/*.test.ts'],
    },
    server: server_options(),
    build: {
        target: 'esnext',
        cssMinify: true,
        sourcemap: false,
        chunkSizeWarningLimit: CHUNK_SIZE_WARNING_KILOBYTES,
        rolldownOptions: {
            output: {
                legalComments: 'none',
                manualChunks: chunk_of,
            },
        },
    },
})

function chunk_of(module_id: string): string | undefined {
    assert(module_id.length > 0)
    assert(module_id.length <= MODULE_ID_LENGTH_MAX)

    if (!module_id.includes('node_modules')) return undefined
    if (module_id.includes('@tiptap')) return undefined
    if (module_id.includes('tiptap-')) return undefined
    if (module_id.includes('prosemirror')) return undefined
    if (module_id.includes('@tauri-apps')) return 'vendor-tauri'
    if (module_id.includes('vue')) return 'vendor-vue'

    return undefined
}

function server_options(): ServerOptions {
    const host = process.env['TAURI_DEV_HOST'] ?? ''

    assert(host.length <= HOST_LENGTH_MAX)
    assert(!host.includes('/'))

    const options: ServerOptions = {
        port: PORT,
        strictPort: true,
        host: false,
        watch: {
            ignored: ['**/src-tauri/**'],
        },
    }

    if (host.length === 0) return options

    return {
        ...options,
        host,
        hmr: {
            protocol: 'ws',
            host,
            port: PORT_HMR,
        },
    }
}
