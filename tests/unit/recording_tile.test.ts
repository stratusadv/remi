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

function bar_levels(wrapper: VueWrapper): number[] {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    return wrapper.findAll('.recording-tile-bars i').map((bar) => {
        const match = /--level:\s*([\d.]+)/.exec(bar.attributes('style') ?? '')

        assert(match !== null)

        return Number(match[1])
    })
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
    it('shows the title, date and people, and no status pill', async () => {
        const job = job_listing_build({ has_transcript: true })
        const wrapper = mount_tile(job, 'Jane Doe, John Doe')

        await flushPromises()

        expect(wrapper.get('.recording-tile-title').text()).toBe('Weekly sync')
        expect(wrapper.get('.recording-tile-people').text()).toBe('Jane Doe, John Doe')
        expect(wrapper.get('.recording-tile-foot').text()).toBe('Today, 9:00 AM')
        expect(wrapper.find('.recording-tile-status').exists()).toBe(false)
        expect(wrapper.find('.pill').exists()).toBe(false)
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

    it('draws a short waveform bar for bar and lifts a silent peak to the minimum', async () => {
        vi.mocked(ipc.job_waveform_get).mockResolvedValue({
            peaks: [0, 0.5, 1],
            duration_seconds: 30,
        })

        const wrapper = mount_tile(job_listing_build({ id: 'job-wave' }))

        await flushPromises()

        expect(ipc.job_waveform_get).toHaveBeenCalledWith('job-wave', 110)
        expect(bar_levels(wrapper)).toEqual([0.08, 0.5, 1])
    })
})

describe('RecordingTile art', () => {
    it('groups a long waveform into 36 bars without losing its loudest moment', async () => {
        const peaks = [...Array(110).keys()].map((index) => (index === 60 ? 0.95 : 0.1))

        vi.mocked(ipc.job_waveform_get).mockResolvedValue({ peaks, duration_seconds: 600 })

        const wrapper = mount_tile(job_listing_build({ id: 'job-long' }))

        await flushPromises()

        const levels = bar_levels(wrapper)

        expect(levels).toHaveLength(36)
        expect(levels.filter((level) => level === 0.95)).toHaveLength(1)
        expect(levels.filter((level) => level === 0.1)).toHaveLength(35)
    })

    it('gives a recording the same art each time and a valid hue and layout', async () => {
        const first = mount_tile(job_listing_build({ id: 'job-art' }))
        const again = mount_tile(job_listing_build({ id: 'job-art' }))

        await flushPromises()

        const art = first.get('.recording-tile')

        expect(['0', '1', '2', '3']).toContain(art.attributes('data-hue'))
        expect(['0', '1', '2']).toContain(art.attributes('data-layout'))
        expect(again.get('.recording-tile').attributes()).toEqual(art.attributes())
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

describe('RecordingTile ask', () => {
    it('offers Ask beside the star once transcribed and emits it without opening', async () => {
        const wrapper = mount_tile(job_listing_build({ has_transcript: true }))
        const ask = wrapper.get('.recording-tile-ask')

        expect(ask.attributes('aria-label')).toBe('Ask about Weekly sync')
        expect(ask.element.parentElement?.querySelector('.recording-tile-star')).not.toBeNull()

        await ask.trigger('click')

        expect(wrapper.emitted('ask')).toHaveLength(1)
        expect(wrapper.emitted('open')).toBeUndefined()
    })

    it('leaves Ask out until there is something to ask about', () => {
        const fresh = mount_tile(job_listing_build())
        const noted = mount_tile(job_listing_build({ id: 'job-2', has_notes: true }))

        expect(fresh.find('.recording-tile-ask').exists()).toBe(false)
        expect(noted.find('.recording-tile-ask').exists()).toBe(true)
    })
})
