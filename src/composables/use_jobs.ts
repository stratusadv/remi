import { ref } from 'vue'
import { assert } from '../lib/assert'
import { ipc } from '../lib/ipc'
import type { JobID, JobListing, Waveform } from '../types'


const WAVEFORM_BAR_COUNT_TILE = 110
const jobs = ref<JobListing[]>([])
const error_message = ref<string | null>(null)
const waveforms = ref<Map<string, Waveform | null>>(new Map())
const api = Object.freeze({ error_message, favourite_set, jobs, refresh, remove, waveform_load })


export function use_jobs(): typeof api {
    assert(Object.isFrozen(api))
    assert(Array.isArray(jobs.value))

    return api
}

async function favourite_set(job_id: JobID, favourite: boolean): Promise<void> {
    assert(job_id.length > 0)
    assert(typeof favourite === 'boolean')

    error_message.value = null

    return ipc.job_meta_update(job_id, { favourite })
        .then(refresh)
        .catch((error: unknown) => {
            error_message.value = String(error)
        })
}

async function refresh(): Promise<void> {
    error_message.value = null

    try {
        const fetched = await ipc.jobs_list()

        assert(Array.isArray(fetched))

        jobs.value = fetched

        assert(jobs.value.length === fetched.length)
    } catch (error) {
        error_message.value = String(error)
    }
}

async function remove(job_id: JobID): Promise<void> {
    assert(typeof job_id === 'string')
    assert(job_id.length > 0)

    error_message.value = null

    return ipc.job_delete(job_id)
        .then(async () => {
            void waveforms.value.delete(job_id)

            await refresh()
        })
        .catch((error: unknown) => {
            error_message.value = String(error)
        })
}

async function waveform_load(job_id: JobID): Promise<Waveform | null> {
    const cached = waveforms.value.get(job_id)

    if (cached !== undefined) return cached

    const waveform = await ipc.job_waveform_get(job_id, WAVEFORM_BAR_COUNT_TILE)

    waveforms.value.set(job_id, waveform)

    assert(waveforms.value.has(job_id))
    assert(waveforms.value.size > 0)

    return waveform
}
