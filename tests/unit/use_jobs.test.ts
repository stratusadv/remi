import { beforeEach, describe, expect, it, vi } from 'vitest'
import { use_jobs } from '../../src/composables/use_jobs'
import { ipc } from '../../src/lib/ipc'
import { job_listing_build } from './fixtures'
import type { Waveform } from '../../src/types'


vi.mock('../../src/lib/ipc')

const WAVEFORM = Object.freeze<Waveform>({ peaks: [0.2, 0.4], duration_seconds: 12 })
const jobs_state = use_jobs()

beforeEach(() => {
    vi.resetAllMocks()
    jobs_state.jobs.value = []
    jobs_state.error_message.value = null
})

describe('refresh', () => {
    it('replaces the job list from the backend and clears the error', async () => {
        const listing = [job_listing_build({ id: 'a' }), job_listing_build({ id: 'b' })]

        vi.mocked(ipc.jobs_list).mockResolvedValue(listing)
        jobs_state.error_message.value = 'stale'

        await jobs_state.refresh()

        expect(jobs_state.jobs.value).toEqual(listing)
        expect(jobs_state.error_message.value).toBeNull()
    })

    it('records the failure and keeps the previous list', async () => {
        jobs_state.jobs.value = [job_listing_build()]
        vi.mocked(ipc.jobs_list).mockRejectedValue(new Error('no store'))

        await jobs_state.refresh()

        expect(jobs_state.jobs.value).toHaveLength(1)
        expect(jobs_state.error_message.value).toBe('Error: no store')
    })
})

describe('favourite_set', () => {
    it('patches the favourite flag and refreshes', async () => {
        vi.mocked(ipc.job_meta_update).mockResolvedValue(job_listing_build({ favourite: true }))
        vi.mocked(ipc.jobs_list).mockResolvedValue([job_listing_build({ favourite: true })])

        await jobs_state.favourite_set('job-1', true)

        expect(ipc.job_meta_update).toHaveBeenCalledWith('job-1', { favourite: true })
        expect(jobs_state.jobs.value[0]?.favourite).toBe(true)
    })

    it('records the failure without refreshing', async () => {
        vi.mocked(ipc.job_meta_update).mockRejectedValue(new Error('locked'))

        await jobs_state.favourite_set('job-1', false)

        expect(ipc.jobs_list).not.toHaveBeenCalled()
        expect(jobs_state.error_message.value).toBe('Error: locked')
    })
})

describe('remove', () => {
    it('deletes the job, forgets its waveform and refreshes', async () => {
        vi.mocked(ipc.job_waveform_get).mockResolvedValue(WAVEFORM)
        vi.mocked(ipc.job_delete).mockResolvedValue(undefined)
        vi.mocked(ipc.jobs_list).mockResolvedValue([])

        await jobs_state.waveform_load('job-1')
        await jobs_state.remove('job-1')

        expect(ipc.job_delete).toHaveBeenCalledWith('job-1')
        expect(jobs_state.jobs.value).toEqual([])

        await jobs_state.waveform_load('job-1')

        expect(ipc.job_waveform_get).toHaveBeenCalledTimes(2)
    })

    it('records the failure when deletion is refused', async () => {
        vi.mocked(ipc.job_delete).mockRejectedValue('in use')

        await jobs_state.remove('job-1')

        expect(jobs_state.error_message.value).toBe('in use')
        expect(ipc.jobs_list).not.toHaveBeenCalled()
    })
})

describe('waveform_load', () => {
    it('asks the backend for one hundred and ten bars and caches the answer', async () => {
        vi.mocked(ipc.job_waveform_get).mockResolvedValue(WAVEFORM)

        const first = await jobs_state.waveform_load('job-2')
        const second = await jobs_state.waveform_load('job-2')

        expect(first).toEqual(WAVEFORM)
        expect(second).toEqual(WAVEFORM)
        expect(ipc.job_waveform_get).toHaveBeenCalledTimes(1)
        expect(ipc.job_waveform_get).toHaveBeenCalledWith('job-2', 110)
    })

    it('caches a null answer so a missing waveform is not requested twice', async () => {
        vi.mocked(ipc.job_waveform_get).mockResolvedValue(null)

        const first = await jobs_state.waveform_load('job-3')
        const second = await jobs_state.waveform_load('job-3')

        expect(first).toBeNull()
        expect(second).toBeNull()
        expect(ipc.job_waveform_get).toHaveBeenCalledTimes(1)
    })

    it('propagates a backend failure to the caller', async () => {
        vi.mocked(ipc.job_waveform_get).mockRejectedValue(new Error('corrupt'))

        await expect(jobs_state.waveform_load('job-4')).rejects.toThrow('corrupt')
    })
})
