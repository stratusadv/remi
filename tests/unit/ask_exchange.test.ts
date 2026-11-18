import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import AskExchange from '../../src/components/ask_exchange.vue'
import { use_ask } from '../../src/composables/use_ask'
import { use_context_menu } from '../../src/composables/use_context_menu'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import {
    ATTACH_TO,
    PROPERTIES,
    ask_source_build,
    job_meta_build,
    mount_auto_unmount,
    transcript_build,
} from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { Exchange } from '../../src/composables/use_ask'
import type { SegmentRange } from '../../src/types'


vi.mock('../../src/lib/ipc')

const ask_state = use_ask()
const context_menu = use_context_menu()
const pipeline = use_pipeline()

const CITED_TWICE = Object.freeze<Partial<Exchange>>({
    answer: 'Sam drafts it [M1]. Priya reviews it [M2]. Sam ships it [M1].',
    meetings: [job_meta_build({ id: 'job-1', title: 'Weekly sync' })],
    sources: [
        ask_source_build({ job_id: 'job-1', marker: 'M1' }),
        ask_source_build({ heading: 'Next steps', job_id: 'job-1', marker: 'M2' }),
    ],
    state: 'done',
})


function documents_mock(range: SegmentRange | null): void {
    assert(range === null || range.segment_index_first >= 0)
    assert(range === null || range.segment_index_first <= range.segment_index_last)

    vi.mocked(ipc.job_transcript_engines_list).mockResolvedValue(['stratus.listen'])
    vi.mocked(ipc.job_transcript_load).mockResolvedValue(transcript_build(['hello', 'world']))
    vi.mocked(ipc.job_transcript_range_find).mockResolvedValue(range)
    vi.mocked(ipc.job_waveform_get).mockResolvedValue(null)
    vi.mocked(ipc.notes_load).mockResolvedValue('# Notes')
}

function exchange_build(patch: Partial<Exchange>): Exchange {
    assert(typeof patch === 'object')
    assert(patch.state === undefined || patch.state.length > 0)

    return {
        id: crypto.randomUUID(),
        question: 'Who drafts the banner?',
        scope: { kind: 'all' },
        answer: 'Sam drafts it.',
        meetings: [],
        notice: '',
        sources: [],
        state: 'done',
        error: null,
        stream_id: crypto.randomUUID(),
        ...patch,
    }
}

function hovered_numbers(wrapper: VueWrapper, selector: string): string[] {
    assert(!wrapper.vm.$.isUnmounted)
    assert(selector.length > 0)

    return wrapper
        .findAll(selector)
        .filter((badge) => badge.attributes('data-hovered') === 'true')
        .map((badge) => badge.text())
}

function lookup_claim(): string {
    const call = vi.mocked(ipc.job_transcript_range_find).mock.lastCall

    assert(call !== undefined, 'no transcript passage was looked up')
    assert(call[0] === 'job-1')

    return call[1]
}

async function menu_ids(wrapper: VueWrapper): Promise<string[] | null> {
    assert(!wrapper.vm.$.isUnmounted)

    context_menu.close()
    await wrapper.get('.ask-question').trigger('contextmenu')

    const shown = context_menu.menu.value

    if (shown === null) return null

    assert(shown.items.length > 0)

    return shown.items.map((item) => item.id)
}

function mount_exchange(patch: Partial<Exchange>, last: boolean): VueWrapper {
    assert(patch.state !== undefined, 'each case names the state its menu depends on')
    assert(typeof last === 'boolean')

    return mount_shown(exchange_build(patch), last)
}

function mount_shown(exchange: Exchange, last: boolean): VueWrapper {
    assert(exchange.id.length > 0)
    assert(typeof last === 'boolean')

    const wrapper = mount_auto_unmount(AskExchange, {
        [PROPERTIES]: { exchange, last },
        [ATTACH_TO]: document.body,
    })

    return wrapper
}

async function sources_toggle(wrapper: VueWrapper, open: boolean): Promise<void> {
    assert(!wrapper.vm.$.isUnmounted)

    const details = wrapper.get<HTMLDetailsElement>('.ask-sources').element

    assert(details.open !== open)

    details.open = open
    details.dispatchEvent(new Event('toggle'))
    await flushPromises()
}

beforeEach(() => {
    onTestFinished(() => {
        context_menu.close()
        ask_state.sources_open.value = []
        pipeline.pipeline_reset()
        vi.resetAllMocks()
        document.body.innerHTML = ''
    })
})

describe('AskExchange menu', () => {
    it('offers copying and asking again on the latest settled answer', async () => {
        const done = await menu_ids(mount_exchange({ state: 'done' }, true))
        const stopped = await menu_ids(mount_exchange({ state: 'stopped' }, true))

        expect(done).toEqual(['answer_copy', 'retry'])
        expect(stopped).toEqual(['answer_copy', 'retry'])
    })

    it('offers only copying on an answer that is no longer the latest', async () => {
        const earlier = await menu_ids(mount_exchange({ state: 'done' }, false))

        expect(earlier).toEqual(['answer_copy'])
    })

    it('offers only asking again on a failed or empty answer', async () => {
        const failed = mount_exchange({ answer: 'Sam drafts', state: 'failed' }, true)
        const stopped = mount_exchange({ answer: '', state: 'stopped' }, true)
        const failed_ids = await menu_ids(failed)
        const stopped_ids = await menu_ids(stopped)

        expect(failed_ids).toEqual(['retry'])
        expect(stopped_ids).toEqual(['retry'])
    })

    it('shows no menu while the answer is still arriving', async () => {
        const answering = await menu_ids(mount_exchange({ state: 'answering' }, true))
        const searching = await menu_ids(mount_exchange({ answer: '', state: 'searching' }, true))

        expect(answering).toBeNull()
        expect(searching).toBeNull()
    })

    it('asks the question again through its parent', async () => {
        const wrapper = mount_exchange({ state: 'done' }, true)

        await menu_ids(wrapper)
        await context_menu.choose('retry')

        expect(wrapper.emitted('retry')).toHaveLength(1)
    })
})

describe('AskExchange notice', () => {
    const notice_wait = 'You have asked a lot this month, so remi answers one question every 5 '
        + 'minutes. This answer starts in about 4 minutes.'

    const notice_slow = 'You have asked a lot this month, so remi answers one question every 5 '
        + 'minutes.'

    it('shows the wait for a turn as the status while the question waits', () => {
        const patch_waiting: Partial<Exchange> = {
            answer: '',
            notice: notice_wait,
            state: 'searching',
        }

        const waiting = mount_exchange(patch_waiting, true)
        const searching = mount_exchange({ answer: '', state: 'searching' }, true)

        expect(waiting.get('.ask-status').text()).toBe(notice_wait)
        expect(waiting.find('.ask-notice').exists()).toBe(false)
        expect(searching.get('.ask-status').text()).toBe('Searching your meetings')
    })

    it('shows the turn notice under an answer and nothing when the turn had none', () => {
        const noted = mount_exchange({ notice: notice_slow, state: 'done' }, true)
        const answering = mount_exchange({ notice: notice_slow, state: 'answering' }, true)
        const plain = mount_exchange({ state: 'done' }, true)

        expect(noted.get('.ask-notice').text()).toBe(notice_slow)
        expect(answering.get('.ask-notice').text()).toBe(notice_slow)
        expect(plain.find('.ask-notice').exists()).toBe(false)
    })

    it('shows the refusal and no notice when a question fails', () => {
        const patch_failed: Partial<Exchange> = {
            answer: '',
            error: 'api error: Ask answers questions for 30 days after each recording remi '
                + 'processes. Process a recording to keep asking.',
            notice: notice_slow,
            state: 'failed',
        }

        const failed = mount_exchange(patch_failed, true)

        const problem = failed.get('.ask-problem p').text()

        expect(problem).toContain('Process a recording to keep asking.')
        expect(failed.find('.ask-notice').exists()).toBe(false)
    })
})

describe('AskExchange answer', () => {
    it('shows bold text in bold without its asterisks', () => {
        const answer = '- **QR code sign-up flow**: Sam drafts it.'
        const item = mount_exchange({ answer, state: 'done' }, true).get('.ask-answer li')

        expect(item.get('strong').text()).toBe('QR code sign-up flow')
        expect(item.text()).toBe('QR code sign-up flow: Sam drafts it.')
    })
})

describe('AskExchange sources', () => {
    const cited: Partial<Exchange> = {
        answer: 'Sam drafts it [M1].',
        meetings: [job_meta_build({ id: 'job-1', title: 'Weekly sync' })],
        sources: [ask_source_build({ job_id: 'job-1', marker: 'M1' })],
        state: 'done',
    }

    it('lists each cited source in a closed dropdown under the settled answer', () => {
        const wrapper = mount_exchange(cited, true)
        const rows = wrapper.findAll('.ask-sources .ask-source')

        expect(wrapper.get('.ask-sources-toggle').text()).toBe('1 source')
        expect(wrapper.get<HTMLDetailsElement>('.ask-sources').element.open).toBe(false)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.get('.ask-source-number').text()).toBe('1')
        expect(rows[0]?.get('.ask-source-title').text()).toBe('Weekly sync')
        expect(rows[0]?.get('.ask-source-where').text()).toBe('Decisions')
    })

    it('waits for the answer to settle before listing its sources', () => {
        const answering = mount_exchange({ ...cited, state: 'answering' }, true)

        expect(answering.find('.ask-sources').exists()).toBe(false)
    })

    it('keeps an opened source list open when the answer is shown again', async () => {
        const exchange = exchange_build(cited)
        const other = mount_shown(exchange_build(cited), false)
        const first = mount_shown(exchange, true)

        expect(first.get<HTMLDetailsElement>('.ask-sources').element.open).toBe(false)

        await sources_toggle(first, true)

        expect(ask_state.sources_open.value).toEqual([exchange.id])
        expect(other.get<HTMLDetailsElement>('.ask-sources').element.open).toBe(false)

        first.unmount()

        const again = mount_shown(exchange, true)

        expect(again.get<HTMLDetailsElement>('.ask-sources').element.open).toBe(true)

        await sources_toggle(again, false)

        expect(ask_state.sources_open.value).toEqual([])
    })

    it('forgets every open source list when a new chat starts', async () => {
        ask_state.sources_open.value = ['left-open']

        await ask_state.clear()

        expect(ask_state.sources_open.value).toEqual([])
    })
})

describe('AskExchange source hover', () => {
    it('marks every citation of the listed source under the pointer', async () => {
        const wrapper = mount_exchange(CITED_TWICE, true)

        await sources_toggle(wrapper, true)

        const second = wrapper.findAll('.ask-source')[1]

        assert(second !== undefined)

        await second.trigger('mouseenter')

        expect(hovered_numbers(wrapper, '.ask-cite')).toEqual(['2'])
        expect(hovered_numbers(wrapper, '.ask-source-number')).toEqual(['2'])

        await second.trigger('mouseleave')

        expect(hovered_numbers(wrapper, '.ask-cite')).toEqual([])
        expect(hovered_numbers(wrapper, '.ask-source-number')).toEqual([])
    })

    it('marks the listed source of the citation under the pointer', async () => {
        const wrapper = mount_exchange(CITED_TWICE, true)

        await sources_toggle(wrapper, true)

        const first = wrapper.findAll('.ask-cite')[0]

        assert(first !== undefined)

        await first.trigger('mouseenter')

        expect(hovered_numbers(wrapper, '.ask-source-number')).toEqual(['1'])
        expect(hovered_numbers(wrapper, '.ask-cite')).toEqual(['1', '1'])

        await first.trigger('mouseleave')

        expect(hovered_numbers(wrapper, '[data-hovered="true"]')).toEqual([])
    })
})

describe('AskExchange source opening', () => {
    it('opens a notes citation on the transcript passage its own sentence matches', async () => {
        documents_mock({ segment_index_first: 4, segment_index_last: 6 })

        const second = mount_exchange(CITED_TWICE, true).findAll('.ask-cite')[1]

        assert(second !== undefined)

        await second.trigger('click')
        await flushPromises()

        expect(lookup_claim()).toContain('Priya reviews it')
        expect(lookup_claim()).not.toContain('Sam')
        expect(pipeline.view_current.value).toBe('transcribe')

        expect(pipeline.segment_focus.value).toEqual({
            job_id: 'job-1',
            segment_index_first: 4,
            segment_index_last: 6,
        })
    })

    it('opens a listed notes source on its notes when no passage matches', async () => {
        documents_mock(null)

        const wrapper = mount_exchange(CITED_TWICE, true)

        await sources_toggle(wrapper, true)
        await wrapper.get('.ask-source').trigger('click')
        await flushPromises()

        expect(lookup_claim()).toContain('Sam drafts it')
        expect(lookup_claim()).toContain('Sam ships it')
        expect(lookup_claim()).not.toContain('Priya')
        expect(pipeline.view_current.value).toBe('notes')
        expect(pipeline.segment_focus.value).toBeNull()
    })

    it('opens a transcript citation at its own passage without a lookup', async () => {
        documents_mock(null)

        const moment = ask_source_build({
            job_id: 'job-1',
            marker: 'M1',
            segment_index_first: 2,
            segment_index_last: 3,
            source: 'transcript',
            start_seconds: 60,
        })

        const wrapper = mount_exchange({ ...CITED_TWICE, sources: [moment] }, true)

        await wrapper.get('.ask-cite').trigger('click')
        await flushPromises()

        expect(ipc.job_transcript_range_find).not.toHaveBeenCalled()
        expect(pipeline.view_current.value).toBe('transcribe')

        expect(pipeline.segment_focus.value).toEqual({
            job_id: 'job-1',
            segment_index_first: 2,
            segment_index_last: 3,
        })
    })
})
