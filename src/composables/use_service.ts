import { computed, ref } from 'vue'
import { assert } from '../lib/assert'
import { ipc } from '../lib/ipc'
import type { APIEndpointPurpose, APIKey, ServiceStatus } from '../types'


const status = ref<ServiceStatus>({
    host: { builtin: false, user: false },
    notes: { builtin: false, length: 0, user: false },
    transcription: { builtin: false, length: 0, user: false },
})

const error_message = ref<string | null>(null)
const host_ready = computed(() => status.value.host.builtin || status.value.host.user)

const notes_ready = computed(
    () => host_ready.value && (status.value.notes.builtin || status.value.notes.user),
)

const transcription_ready = computed(
    () => host_ready.value
        && (status.value.transcription.builtin || status.value.transcription.user),
)

const api = Object.freeze({
    status,
    error_message,
    host_ready,
    notes_ready,
    transcription_ready,
    refresh,
    api_key_set,
})


export function use_service(): typeof api {
    assert(Object.isFrozen(api))
    assert(typeof status.value === 'object')

    return api
}

async function api_key_set(purpose: APIEndpointPurpose, api_key: APIKey): Promise<void> {
    assert(purpose.length > 0)
    assert(typeof api_key === 'string')

    error_message.value = null

    return ipc.service_api_key_set(purpose, api_key).then(refresh)
}

async function refresh(): Promise<void> {
    error_message.value = null

    try {
        const fetched = await ipc.service_status()

        assert(typeof fetched === 'object')

        status.value = fetched

        assert(typeof status.value.host === 'object')
    } catch (error) {
        error_message.value = String(error)
    }
}
