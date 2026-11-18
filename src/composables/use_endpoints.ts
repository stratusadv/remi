import { ref } from 'vue'
import { assert } from '../lib/assert'
import { error_shown } from '../lib/errors'
import { ipc } from '../lib/ipc'
import type { APIEndpoint, APIEndpointPurpose } from '../types'


export const MESSAGE_ENDPOINT_MISSING = 'remi could not load its AI service. Restart remi and '
    + 'try again.'

const endpoints = ref<APIEndpoint[]>([])
const error_message = ref<string | null>(null)
const api = Object.freeze({ endpoints, error_message, refresh, endpoints_by_purpose })


export function use_endpoints(): typeof api {
    assert(endpoints.value.every((endpoint) => endpoint.api_key.length === 0))
    assert(Array.isArray(endpoints.value))

    return api
}

function endpoints_by_purpose(purpose: APIEndpointPurpose): APIEndpoint[] {
    assert(purpose.length > 0)

    const matching = endpoints.value.filter((endpoint) => endpoint.purpose === purpose)

    assert(matching.length <= endpoints.value.length)

    return matching
}

async function refresh(): Promise<void> {
    error_message.value = null

    try {
        const fetched = await ipc.endpoints_list()

        assert(Array.isArray(fetched))

        endpoints.value = fetched

        assert(endpoints.value.length === fetched.length)
    } catch (error) {
        error_message.value = error_shown(error)
    }
}
