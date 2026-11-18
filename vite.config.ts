import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
import type { Plugin, ServerOptions } from 'vite'


interface ComponentRequest {
    pathname: string
    root: string
}

const CHUNK_SIZE_WARNING_KILOBYTES = 1_024
const COMPONENT_DIRECTORY = '/src/'
const COMPONENT_EXTENSION = '.vue'
const HOST_LENGTH_MAX = 253
const MODULE_ID_LENGTH_MAX = 4_096
const PORT = 1_420
const PORT_HMR = 1_421
const STATUS_NOT_FOUND = 404
const URL_BASE = 'http://localhost'


export default defineConfig({
    plugins: [component_missing_plugin(), vue(), tailwindcss()],
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

function component_missing({ pathname, root }: ComponentRequest): boolean {
    assert(path.isAbsolute(root))
    assert(pathname.startsWith('/'))

    if (!pathname.startsWith(COMPONENT_DIRECTORY)) return false
    if (!pathname.endsWith(COMPONENT_EXTENSION)) return false

    return !existsSync(path.join(root, pathname))
}

function component_missing_plugin(): Plugin {
    return {
        name: 'remi:component-missing',
        configureServer(server) {
            assert(path.isAbsolute(server.config.root))
            assert(server.config.base === '/')

            server.middlewares.use((request, response, next) => {
                assert(request.url !== undefined)
                assert(!response.headersSent)

                const pathname = new URL(request.url, URL_BASE).pathname

                if (!component_missing({ pathname, root: server.config.root })) {
                    next()

                    return
                }

                response.writeHead(STATUS_NOT_FOUND)
                response.end()
            })
        },
    }
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
            ignored: ['**/.venv/**', '**/server/**', '**/src-tauri/**', '**/target/**'],
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
