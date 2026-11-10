import { ref } from 'vue'
import { assert } from '../lib/assert'
import { ipc } from '../lib/ipc'
import type { Settings } from '../types'


const settings_default = Object.freeze<Settings>({
    notes_template_id_default: null,
    theme: null,
    palette: null,
    recordings_directory: null,
    notes_model: null,
    notes_thinking: null,
    api_host: null,
    jobs_view: null,
})

const settings = ref<Settings>({ ...settings_default })
const error_message = ref<string | null>(null)
const api = Object.freeze({ settings, error_message, refresh, update })


export function use_settings(): typeof api {
    assert(Object.isFrozen(api))
    assert(Object.isFrozen(settings_default))

    return api
}

async function refresh(): Promise<void> {
    error_message.value = null

    try {
        const fetched = await ipc.settings_get()

        assert(typeof fetched === 'object')

        settings.value = fetched

        assert(settings.value.api_host === fetched.api_host)
    } catch (error) {
        error_message.value = String(error)
    }
}

async function update(patch: Partial<Settings>): Promise<void> {
    assert(typeof patch === 'object')
    assert(typeof settings.value === 'object')

    error_message.value = null

    const next: Settings = { ...settings.value, ...patch }

    return ipc.settings_update(next)
        .then(() => {
            settings.value = next
        })
        .catch((error: unknown) => {
            error_message.value = String(error)
        })
}
