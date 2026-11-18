import { invoke } from '@tauri-apps/api/core'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assert } from '../../src/lib/assert'
import { IPCError } from '../../src/lib/errors'
import { ipc } from '../../src/lib/ipc'
import { deferred_new } from './fixtures'


vi.mock('@tauri-apps/api/core')

const COMMANDS_INVOKED_MAX = 8
const JOB_ID = '0123456789abcdef0123456789abcdef'
const NOTES_SAVED = '# Notes\n\nThe rollout moved to Friday.\n'
const TARGET_PATH = '/home/user/Documents/notes.docx'

const TRACEBACK = 'api error: 500 transcription charge: Traceback (most recent call last):\n'
    + 'psycopg.errors.UndefinedColumn: column "account"."is_complimentary" does not exist'


afterEach(() => {
    vi.mocked(invoke).mockReset()
    vi.restoreAllMocks()
})

function commands_invoked(): string[] {
    assert(vi.isMockFunction(invoke))
    assert(vi.mocked(invoke).mock.calls.length <= COMMANDS_INVOKED_MAX)

    return vi.mocked(invoke).mock.calls.map(([command]) => command)
}

describe('ipc notes commands after a pending save', () => {
    it('reads notes only after the save sent before it has finished', async () => {
        const save = deferred_new<undefined>()

        vi.mocked(invoke)
            .mockReturnValueOnce(save.promise)
            .mockResolvedValueOnce(NOTES_SAVED)

        const saved = ipc.notes_save(JOB_ID, NOTES_SAVED)
        const loaded = ipc.notes_load(JOB_ID)

        await flushPromises()

        expect(commands_invoked()).toEqual(['notes_save'])

        save.resolve(undefined)

        await saved

        await expect(loaded).resolves.toBe(NOTES_SAVED)
        expect(commands_invoked()).toEqual(['notes_save', 'notes_load'])
    })

    it('prints and exports the notes only after the save sent before them', async () => {
        const save = deferred_new<undefined>()

        vi.mocked(invoke)
            .mockReturnValueOnce(save.promise)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(TARGET_PATH)

        const saved = ipc.notes_save(JOB_ID, NOTES_SAVED)
        const printed = ipc.notes_print(JOB_ID)
        const exported = ipc.notes_export(JOB_ID, TARGET_PATH)

        await flushPromises()

        expect(commands_invoked()).toEqual(['notes_save'])

        save.resolve(undefined)

        await Promise.all([saved, printed])

        await expect(exported).resolves.toBe(TARGET_PATH)
        expect(commands_invoked()).toEqual(['notes_save', 'notes_print', 'notes_export'])
    })
})

describe('ipc notes commands beside failures and other commands', () => {
    it('reads notes after a save that failed', async () => {
        vi.mocked(invoke)
            .mockRejectedValueOnce(new Error('the disk is full'))
            .mockResolvedValueOnce(NOTES_SAVED)

        const saved = ipc.notes_save(JOB_ID, NOTES_SAVED)
        const loaded = ipc.notes_load(JOB_ID)

        await expect(saved).rejects.toBeInstanceOf(IPCError)
        await expect(loaded).resolves.toBe(NOTES_SAVED)
        expect(commands_invoked()).toEqual(['notes_save', 'notes_load'])
    })

    it('sends a command that does not touch notes while a notes save is pending', async () => {
        const save = deferred_new<undefined>()

        vi.mocked(invoke).mockImplementation(async (command) => (
            command === 'notes_save' ? save.promise : null
        ))

        const saved = ipc.notes_save(JOB_ID, NOTES_SAVED)
        const meta = ipc.job_meta_get(JOB_ID)

        await expect(meta).resolves.toBeNull()
        expect(commands_invoked()).toContain('job_meta_get')

        save.resolve(undefined)

        await saved

        expect(commands_invoked()).toHaveLength(2)
    })
})

describe('ipc failures', () => {
    it('logs the full reason of a failed command and rejects with a short one', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        vi.mocked(invoke).mockRejectedValueOnce(TRACEBACK)

        const failure = await ipc.notes_load(JOB_ID).catch((error: unknown) => error)

        expect(warn.mock.calls).toEqual([[`[ipc] notes_load failed: ${TRACEBACK}`]])

        assert(failure instanceof IPCError)

        expect(failure.raw).toBe(TRACEBACK)
        expect(failure.command).toBe('notes_load')
        expect(String(failure)).not.toContain('Traceback')
        expect(String(failure)).not.toContain('psycopg')
        expect(commands_invoked()).toEqual(['notes_load'])
    })
})
