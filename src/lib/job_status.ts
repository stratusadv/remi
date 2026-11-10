import { assert } from './assert'
import { seconds_to_clock_hours } from './duration'
import type { JobListing } from '../types'


export type JobStatusState = 'notes' | 'transcript' | 'none'

export interface JobStatus {
    state: JobStatusState
    text: string
}


export function job_duration_text(job: JobListing): string | null {
    assert(job.id.length > 0)
    assert(job.duration_seconds === null || typeof job.duration_seconds === 'number')

    if (job.duration_seconds === null) return null

    return seconds_to_clock_hours(job.duration_seconds)
}

export function job_status(job: JobListing): JobStatus {
    assert(job.id.length > 0)
    assert(typeof job.has_notes === 'boolean')

    if (job.has_notes) return { state: 'notes', text: 'Notes ready' }
    if (job.has_transcript) return { state: 'transcript', text: 'Transcribed' }

    return { state: 'none', text: 'Not transcribed' }
}
