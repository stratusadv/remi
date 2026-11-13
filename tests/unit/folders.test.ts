import { describe, expect, it } from 'vitest'
import {
    FOLDER_NAME_CHARS_MAX,
    folder_compare,
    folder_key,
    folder_name_problem,
    folders_merge,
} from '../../src/lib/folders'
import { job_listing_build } from './fixtures'


const FOLDERS = Object.freeze(['Acme Mining', 'Hiring'])
const SAVED_POOL = Object.freeze(['Apollo', 'Delta', 'gamma', 'Omega'])
const SEEDS = 50


describe('folders_merge', () => {
    it('lists each folder once, trimmed, ignoring case, in order', () => {
        const jobs = [
            job_listing_build({ id: 'a', project: ' Apollo ' }),
            job_listing_build({ id: 'b', project: 'apollo' }),
            job_listing_build({ id: 'c', project: 'beta' }),
            job_listing_build({ id: 'd', project: '   ' }),
            job_listing_build({ id: 'e', project: null }),
            job_listing_build({ id: 'f', project: 'Zeta' }),
        ]

        expect(folders_merge([], jobs)).toEqual(['Apollo', 'beta', 'Zeta'])
    })

    it('keeps an empty saved folder and prefers the saved spelling', () => {
        const jobs = [
            job_listing_build({ id: 'a', project: 'acme mining' }),
            job_listing_build({ id: 'b', project: 'Delta' }),
        ]

        expect(folders_merge(FOLDERS, jobs)).toEqual(['Acme Mining', 'Delta', 'Hiring'])
    })

    it('names every saved folder and every meeting folder exactly once', () => {
        const names = ['Apollo', 'apollo ', ' Beta', 'beta', 'Gamma', '', 'GAMMA']

        for (let seed = 1; seed <= SEEDS; seed += 1) {
            const saved = SAVED_POOL
                .filter((name) => Math.floor(seed / 2 ** SAVED_POOL.indexOf(name)) % 2 === 1)

            const jobs = names.map((name, index) => job_listing_build({
                id: `job-${String(index)}`,
                project: names[(seed * (index + 3)) % names.length] ?? name,
            }))

            const listed = folders_merge(saved, jobs)

            const wanted = new Set([...saved, ...jobs.map((job) => job.project ?? '')]
                .map(folder_key)
                .filter((key) => key.length > 0))

            const orders = listed
                .slice(1)
                .map((folder, index) => folder_compare(listed[index] ?? folder, folder))

            expect(new Set(listed.map(folder_key))).toEqual(wanted)
            expect(listed).toHaveLength(wanted.size)
            expect(orders.every((order) => order < 0)).toBe(true)
            expect(saved.every((folder) => listed.includes(folder))).toBe(true)
        }
    })
})

describe('folder_name_problem', () => {
    it('accepts a new name and a case-only rename of the same folder', () => {
        expect(folder_name_problem('Board', FOLDERS, null)).toBeNull()
        expect(folder_name_problem('  Board  ', FOLDERS, null)).toBeNull()
        expect(folder_name_problem('hiring', FOLDERS, 'Hiring')).toBeNull()
    })

    it('refuses a blank, repeated, multi-line, or overlong name', () => {
        expect(folder_name_problem('   ', FOLDERS, null)).toBe('A folder needs a name.')
        expect(folder_name_problem('two\nlines', FOLDERS, null)).toContain('one line')
        expect(folder_name_problem('ACME MINING', FOLDERS, null)).toContain('already exists')
        expect(folder_name_problem('Hiring', FOLDERS, 'Acme Mining')).toContain('already exists')

        expect(folder_name_problem('x'.repeat(FOLDER_NAME_CHARS_MAX + 1), FOLDERS, null))
            .toContain(String(FOLDER_NAME_CHARS_MAX))
    })

    it('counts characters, not UTF-16 units, against the length limit', () => {
        const widest = '\u{1F4C1}'.repeat(FOLDER_NAME_CHARS_MAX)

        expect(widest.length).toBe(FOLDER_NAME_CHARS_MAX * 2)
        expect(folder_name_problem(widest, FOLDERS, null)).toBeNull()
        expect(folder_name_problem(`${widest}x`, FOLDERS, null)).not.toBeNull()
    })
})

describe('folder_key', () => {
    it('matches names that differ only in case or surrounding space', () => {
        expect(folder_key('  Acme Mining ')).toBe(folder_key('ACME MINING'))
        expect(folder_key('Acme')).not.toBe(folder_key('Acme Mining'))
        expect(folder_key('   ')).toBe('')
    })
})
