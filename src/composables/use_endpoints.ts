import { ref } from 'vue'
import { assert } from '../lib/assert'
import { ipc } from '../lib/ipc'
import type { APIEndpoint, APIEndpointPurpose } from '../types'


const endpoints = ref<APIEndpoint[]>([])
const error_message = ref<string | null>(null)
const api = Object.freeze({ endpoints, error_message, refresh, endpoints_by_purpose })


export function use_endpoints(): typeof api {
    assert(Object.isFrozen(api))
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
        error_message.value = String(error)
    }
}
