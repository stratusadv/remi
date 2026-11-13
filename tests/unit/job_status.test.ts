import { describe, expect, it } from 'vitest'
import { job_askable, job_duration_text, job_status, job_title } from '../../src/lib/job_status'
import { job_listing_build, job_meta_build } from './fixtures'


describe('job_askable', () => {
    it('allows asking once a transcript or notes exist, and not before', () => {
        expect(job_askable(job_listing_build())).toBe(false)
        expect(job_askable(job_listing_build({ has_transcript: true }))).toBe(true)
        expect(job_askable(job_listing_build({ has_notes: true }))).toBe(true)
        expect(job_askable(job_listing_build({ has_notes: true, has_transcript: true }))).toBe(true)
    })
})

describe('job_duration_text', () => {
    it('returns null when the duration is unknown', () => {
        expect(job_duration_text(job_listing_build({ duration_seconds: null }))).toBeNull()
    })

    it('formats a short duration without an hours field', () => {
        expect(job_duration_text(job_listing_build({ duration_seconds: 144 }))).toBe('2:24')
    })

    it('formats a long duration with an hours field', () => {
        expect(job_duration_text(job_listing_build({ duration_seconds: 3725 }))).toBe('1:02:05')
    })
})

describe('job_status', () => {
    it('reports notes ready when notes exist, regardless of the transcript', () => {
        const status = job_status(job_listing_build({ has_notes: true, has_transcript: false }))

        expect(status).toEqual({ state: 'notes', text: 'Notes ready' })
    })

    it('reports transcribed when only a transcript exists', () => {
        const status = job_status(job_listing_build({ has_notes: false, has_transcript: true }))

        expect(status).toEqual({ state: 'transcript', text: 'Transcribed' })
    })

    it('reports not transcribed when neither exists', () => {
        expect(job_status(job_listing_build())).toEqual({ state: 'none', text: 'Not transcribed' })
    })
})

describe('job_title', () => {
    it('prefers the title, then the label', () => {
        const titled = job_meta_build({ title: 'Weekly sync', label: 'Retro' })

        expect(job_title(titled)).toBe('Weekly sync')
        expect(job_title({ ...titled, title: '' })).toBe('Retro')
        expect(job_title({ ...titled, title: null })).toBe('Retro')
    })

    it('falls back to the file name without its extension', () => {
        expect(job_title(job_meta_build())).toBe('weekly-sync')

        const recording = job_meta_build({ source_path: 'C:\\Users\\you\\Music\\Recording 1.wav' })

        expect(job_title(recording)).toBe('Recording 1')
    })
})
