import { assert } from './assert'
import { seconds_to_clock_hours } from './duration'
import { path_file_stem } from './paths'
import type { JobListing, JobMeta } from '../types'


export type JobStatusState = 'notes' | 'transcript' | 'none'

export interface JobStatus {
    state: JobStatusState
    text: string
}


export function job_askable(job: JobListing): boolean {
    assert(job.id.length > 0)
    assert(typeof job.has_notes === 'boolean')
    assert(typeof job.has_transcript === 'boolean')

    return job.has_notes || job.has_transcript
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

export function job_title(job: JobMeta): string {
    assert(job.id.length > 0)
    assert(typeof job.source_path === 'string')

    const title = job.title ?? ''
    const label = job.label ?? ''

    if (title.length > 0) return title
    if (label.length > 0) return label

    return path_file_stem(job.source_path)
}
