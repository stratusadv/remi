import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assert } from '../../src/lib/assert'
import { log_error, log_information, log_warn } from '../../src/lib/log'


interface LogLine {
    readonly level: string
    readonly message: string
}

vi.mock('@tauri-apps/api/core')

const LINES_WRITTEN_MAX = 4
const TAURI_INTERNALS = '__TAURI_INTERNALS__'
const TAURI_INTERNALS_STANDIN = Object.freeze({ invoke })


beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue(null)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
    Reflect.deleteProperty(globalThis, TAURI_INTERNALS)
    vi.mocked(invoke).mockReset()
    vi.restoreAllMocks()
})

function lines_written(): LogLine[] {
    assert(vi.isMockFunction(invoke))
    assert(vi.mocked(invoke).mock.calls.length <= LINES_WRITTEN_MAX)

    return vi.mocked(invoke).mock.calls.map(([command, call]) => {
        assert(command === 'log_write')
        assert(call !== undefined)

        const level: unknown = Reflect.get(call, 'level')
        const message: unknown = Reflect.get(call, 'message')

        assert(typeof level === 'string')
        assert(typeof message === 'string')

        return { level, message }
    })
}

describe('log', () => {
    it('writes each level to the log file inside the app', () => {
        Reflect.set(globalThis, TAURI_INTERNALS, TAURI_INTERNALS_STANDIN)

        log_error('[test] the save failed', new Error('the disk is full'))
        log_information('[test] synced', 'job-1')
        log_warn('[test] slow', { seconds: 73 })

        const [error, information, warning] = lines_written()

        expect(error?.level).toBe('error')
        expect(error?.message).toContain('[test] the save failed Error: the disk is full')
        expect(information).toEqual({ level: 'information', message: '[test] synced job-1' })
        expect(warning).toEqual({ level: 'warning', message: '[test] slow {"seconds":73}' })
    })

    it('writes only to the console outside the app', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        log_warn('[test] slow', 'job-1')

        expect(lines_written()).toEqual([])
        expect(warn).toHaveBeenCalledWith('[test] slow', 'job-1')
    })

    it('writes a detail that cannot become JSON without throwing', () => {
        const looped: Record<string, unknown> = {}
        const line = { level: 'warning', message: '[test] looped [object Object]' }

        looped['self'] = looped
        Reflect.set(globalThis, TAURI_INTERNALS, TAURI_INTERNALS_STANDIN)

        log_warn('[test] looped', looped)

        expect(lines_written()).toEqual([line])
    })

    it('keeps the line on the console when the log file refuses it', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        Reflect.set(globalThis, TAURI_INTERNALS, TAURI_INTERNALS_STANDIN)
        vi.mocked(invoke).mockRejectedValueOnce('io error: the disk is full')

        log_information('[test] synced')

        await vi.waitFor(() => {
            expect(warn).toHaveBeenCalledWith(
                '[remi] the log file did not take a line',
                'io error: the disk is full',
            )
        })
    })
})
