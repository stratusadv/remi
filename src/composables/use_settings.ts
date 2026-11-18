import { ref, shallowRef } from 'vue'
import { assert } from '../lib/assert'
import { error_shown } from '../lib/errors'
import { ipc } from '../lib/ipc'
import type { Settings } from '../types'


const settings_default = Object.freeze<Settings>({
    notes_template_id_default: null,
    mode: null,
    theme: null,
    palette: null,
    recordings_directory: null,
    jobs_view: null,
})

const settings = ref<Settings>({ ...settings_default })
const error_message = ref<string | null>(null)
const api = Object.freeze({ settings, error_message, refresh, update })
const update_queue = shallowRef<Promise<void>>(Promise.resolve())


export function use_settings(): typeof api {
    assert(Object.keys(settings.value).length === Object.keys(settings_default).length)
    assert(Object.keys(settings_default).every((key) => key in settings.value))

    return api
}

async function refresh(): Promise<void> {
    error_message.value = null

    try {
        const fetched = await ipc.settings_get()

        assert(typeof fetched === 'object')

        settings.value = fetched

        assert(settings.value.mode === fetched.mode)
    } catch (error) {
        error_message.value = error_shown(error)
    }
}

async function update(patch: Partial<Settings>): Promise<void> {
    assert(typeof patch === 'object')
    assert(typeof update_queue.value.then === 'function')

    const queued = update_queue.value.then(async () => update_send(patch))

    update_queue.value = queued

    return queued
}

async function update_send(patch: Partial<Settings>): Promise<void> {
    assert(typeof patch === 'object')
    assert(typeof settings.value === 'object')

    error_message.value = null

    const next: Settings = { ...settings.value, ...patch }

    return ipc.settings_update(next)
        .then(() => {
            settings.value = next
        })
        .catch((error: unknown) => {
            error_message.value = error_shown(error)
        })
}
