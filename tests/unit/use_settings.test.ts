import { beforeEach, describe, expect, it, vi } from 'vitest'
import { use_settings } from '../../src/composables/use_settings'
import { ipc } from '../../src/lib/ipc'
import type { Settings } from '../../src/types'


vi.mock('../../src/lib/ipc')

const SETTINGS_EMPTY = Object.freeze<Settings>({
    notes_template_id_default: null,
    mode: null,
    theme: null,
    palette: null,
    recordings_directory: null,
    jobs_view: null,
})

const settings_state = use_settings()

beforeEach(() => {
    vi.resetAllMocks()
    settings_state.settings.value = { ...SETTINGS_EMPTY }
    settings_state.error_message.value = null
})

describe('refresh', () => {
    it('loads the settings from the backend', async () => {
        const loaded: Settings = { ...SETTINGS_EMPTY, mode: 'light', jobs_view: 'list' }

        vi.mocked(ipc.settings_get).mockResolvedValue(loaded)

        await settings_state.refresh()

        expect(settings_state.settings.value).toEqual(loaded)
        expect(settings_state.error_message.value).toBeNull()
    })

    it('records the failure and keeps the defaults', async () => {
        vi.mocked(ipc.settings_get).mockRejectedValue(new Error('unreadable'))

        await settings_state.refresh()

        expect(settings_state.settings.value).toEqual(SETTINGS_EMPTY)
        expect(settings_state.error_message.value).toBe('unreadable')
    })
})

describe('update', () => {
    it('sends the merged settings and applies them locally on success', async () => {
        settings_state.settings.value = { ...SETTINGS_EMPTY, mode: 'dark' }
        vi.mocked(ipc.settings_update).mockResolvedValue(undefined)

        await settings_state.update({ palette: 'nord', jobs_view: 'grid' })

        expect(ipc.settings_update).toHaveBeenCalledWith({
            ...SETTINGS_EMPTY,
            mode: 'dark',
            palette: 'nord',
            jobs_view: 'grid',
        })

        expect(settings_state.settings.value.palette).toBe('nord')
        expect(settings_state.settings.value.mode).toBe('dark')
    })

    it('keeps the old settings when the backend rejects the update', async () => {
        vi.mocked(ipc.settings_update).mockRejectedValue(new Error('read only'))

        await settings_state.update({ mode: 'light' })

        expect(settings_state.settings.value.mode).toBeNull()
        expect(settings_state.error_message.value).toBe('read only')
    })

    it('builds each update on the one before it when both are sent at once', async () => {
        vi.mocked(ipc.settings_update).mockResolvedValue(undefined)

        const first = settings_state.update({ theme: 'standard' })
        const second = settings_state.update({ mode: 'light' })

        await Promise.all([first, second])

        expect(ipc.settings_update).toHaveBeenLastCalledWith({
            ...SETTINGS_EMPTY,
            mode: 'light',
            theme: 'standard',
        })

        expect(settings_state.settings.value.theme).toBe('standard')
        expect(settings_state.settings.value.mode).toBe('light')
    })

    it('still sends a later update after an earlier one is refused', async () => {
        vi.mocked(ipc.settings_update)
            .mockRejectedValueOnce(new Error('read only'))
            .mockResolvedValueOnce(undefined)

        const refused = settings_state.update({ theme: 'standard' })
        const accepted = settings_state.update({ mode: 'light' })

        await Promise.all([refused, accepted])

        expect(ipc.settings_update).toHaveBeenCalledTimes(2)
        expect(settings_state.settings.value.theme).toBeNull()
        expect(settings_state.settings.value.mode).toBe('light')
    })
})
