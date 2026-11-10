import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RecordingTile from '../../src/components/recording_tile.vue'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, PROPERTIES, job_listing_build } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { JobListing } from '../../src/types'


vi.mock('../../src/lib/ipc')

const MENU_ITEMS = Object.freeze([{ id: 'rename', label: 'Rename', icon: 'edit' }] as const)
const mounted = new Set<VueWrapper>()


type TilePeople = string | null
type TileSnippet = string | null

function mount_tile(
    job: JobListing,
    people: TilePeople = null,
    snippet: TileSnippet = null,
): VueWrapper {
    assert(job.id.length > 0)
    assert(mounted.size >= 0)
    assert(people === null || people.length > 0)
    assert(snippet === null || snippet.length > 0)

    const wrapper = mount(RecordingTile, {
        [PROPERTIES]: {
            job,
            title: 'Weekly sync',
            when: 'Today, 9:00 AM',
            people,
            snippet,
            menu_items: [...MENU_ITEMS],
        },
        [ATTACH_TO]: document.body,
    })

    mounted.add(wrapper)

    return wrapper
}

function shape_of(wrapper: VueWrapper): string {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    return wrapper.findAll('rect').map((word) => word.attributes('width')).join(',')
}

beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(ipc.job_waveform_get).mockResolvedValue(null)
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    document.body.innerHTML = ''
})

describe('RecordingTile', () => {
    it('shows the title, date, people and status', async () => {
        const job = job_listing_build({ has_transcript: true })
        const wrapper = mount_tile(job, 'Jane Doe, John Doe')

        await flushPromises()

        expect(wrapper.get('.recording-tile-title').text()).toBe('Weekly sync')
        expect(wrapper.get('.recording-tile-people').text()).toBe('Jane Doe, John Doe')
        expect(wrapper.get('.recording-tile-foot span').text()).toBe('Today, 9:00 AM')
        expect(wrapper.get('.recording-tile-status').text()).toBe('Transcribed')
        expect(wrapper.get('.recording-tile-status').attributes('data-state')).toBe('transcript')
    })

    it('prefers the search snippet over the people text', async () => {
        const wrapper = mount_tile(job_listing_build(), 'Jane Doe', 'In notes: retry policy')

        await flushPromises()

        expect(wrapper.get('.recording-tile-people').text()).toBe('In notes: retry policy')
    })

    it('falls back to a no participants label', async () => {
        const wrapper = mount_tile(job_listing_build())

        await flushPromises()

        expect(wrapper.get('.recording-tile-people').text()).toBe('No participants')
    })

    it('shows the duration only when known', async () => {
        const without = mount_tile(job_listing_build())
        const with_duration = mount_tile(job_listing_build({ duration_seconds: 3725 }))

        await flushPromises()

        expect(without.find('.recording-tile-duration').exists()).toBe(false)
        expect(with_duration.get('.recording-tile-duration').text()).toBe('1:02:05')
    })

    it('draws one bar per waveform peak with a minimum height', async () => {
        vi.mocked(ipc.job_waveform_get).mockResolvedValue({
            peaks: [0, 0.5, 1],
            duration_seconds: 30,
        })

        const wrapper = mount_tile(job_listing_build({ id: 'job-wave' }))

        await flushPromises()

        const bars = wrapper.findAll('rect')

        expect(ipc.job_waveform_get).toHaveBeenCalledWith('job-wave', 110)
        expect(wrapper.get('svg').attributes('viewBox')).toBe('0 0 9 100')
        expect(bars.map((bar) => bar.attributes('height'))).toEqual(['4', '50', '100'])
        expect(bars.map((bar) => bar.attributes('x'))).toEqual(['0', '3', '6'])
        expect(bars[1]?.attributes('y')).toBe('25')
    })
})

describe('RecordingTile', () => {
    it('draws a text glyph instead of a wave when the job has no audio', async () => {
        const wrapper = mount_tile(job_listing_build())

        await flushPromises()

        const glyph = wrapper.get('.recording-tile-glyph')
        const words = glyph.findAll('rect')
        const rows = new Set(words.map((word) => word.attributes('y')))

        expect(glyph.attributes('viewBox')).toBe('0 0 100 100')
        expect(words.length).toBeGreaterThan(5)
        expect(rows.size).toBe(5)
        expect(words.every((word) => word.attributes('height') === '8')).toBe(true)
    })

    it('draws the same glyph for the same job and a different one for another', async () => {
        const first = mount_tile(job_listing_build({ id: 'job-a' }))
        const same = mount_tile(job_listing_build({ id: 'job-a' }))
        const other = mount_tile(job_listing_build({ id: 'job-b' }))

        await flushPromises()

        expect(shape_of(first)).toBe(shape_of(same))
        expect(shape_of(first)).not.toBe(shape_of(other))
    })

    it('warns and keeps rendering when the waveform fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        vi.mocked(ipc.job_waveform_get).mockRejectedValue(new Error('corrupt'))

        const wrapper = mount_tile(job_listing_build({ id: 'job-fail' }))

        await flushPromises()

        expect(warn).toHaveBeenCalledWith(
            '[recordings] waveform unavailable',
            'job-fail',
            expect.any(Error),
        )

        expect(wrapper.get('.recording-tile-title').text()).toBe('Weekly sync')

        warn.mockRestore()
    })

    it('emits open on click and on enter', async () => {
        const wrapper = mount_tile(job_listing_build())

        await wrapper.get('article').trigger('click')
        await wrapper.get('article').trigger('keydown', { key: 'Enter' })

        expect(wrapper.emitted('open')).toHaveLength(2)
    })

    it('emits favourite from the star without opening', async () => {
        const wrapper = mount_tile(job_listing_build({ favourite: true }))

        expect(wrapper.get('.recording-tile-star').attributes('aria-pressed')).toBe('true')

        await wrapper.get('.recording-tile-star').trigger('click')

        expect(wrapper.emitted('favourite')).toHaveLength(1)
        expect(wrapper.emitted('open')).toBeUndefined()
    })
})

describe('RecordingTile', () => {
    it('forwards a menu selection with its id', async () => {
        const wrapper = mount_tile(job_listing_build())

        await wrapper.get('.menu-icon-btn').trigger('click')

        document.body.querySelector('[role="menuitem"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        )

        await wrapper.vm.$nextTick()

        expect(wrapper.emitted('menu')).toEqual([['rename']])
        expect(wrapper.emitted('open')).toBeUndefined()
    })
})
