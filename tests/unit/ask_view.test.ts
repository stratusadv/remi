import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import AskView from '../../src/components/ask_view.vue'
import { use_ask } from '../../src/composables/use_ask'
import { use_endpoints } from '../../src/composables/use_endpoints'
import { use_jobs } from '../../src/composables/use_jobs'
import { use_network } from '../../src/composables/use_network'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, job_listing_build, mount_auto_unmount } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { Mock } from 'vitest'
import type { AppConfig } from 'vue'
import type { Exchange } from '../../src/composables/use_ask'


vi.mock('../../src/lib/ipc')

const KEY_ERROR_HANDLER = 'errorHandler'
const SCROLL_CLIENT_PX = 500
const SCROLL_HEIGHT_PX = 2000
const ask_state = use_ask()
const { endpoints } = use_endpoints()
const { jobs } = use_jobs()
const { online } = use_network()

type ErrorHandler = NonNullable<AppConfig['errorHandler']>


function exchange_done(question: string): Exchange {
    assert(question.length > 0)
    assert(question === question.trim())

    return {
        id: crypto.randomUUID(),
        question,
        scope: { kind: 'all' },
        answer: 'Sam drafts the banner copy.',
        meetings: [],
        notice: '',
        sources: [],
        state: 'done',
        error: null,
        stream_id: crypto.randomUUID(),
    }
}

function view_mount(error_handler: Mock<ErrorHandler>): VueWrapper {
    assert(vi.isMockFunction(error_handler))
    assert(document.body.querySelector('.ask') === null)

    return mount_auto_unmount(AskView, {
        [ATTACH_TO]: document.body,
        global: { config: { [KEY_ERROR_HANDLER]: error_handler } },
    })
}

beforeEach(() => {
    onTestFinished(() => {
        vi.restoreAllMocks()
    })

    vi.resetAllMocks()
    vi.mocked(ipc.jobs_list).mockResolvedValue([])
    vi.mocked(ipc.notes_ask_warm).mockResolvedValue(undefined)

    ask_state.exchanges.value = []
    ask_state.scope.value = { kind: 'all' }
    ask_state.thread_scroll.value = null
    endpoints.value = []
    jobs.value = []
    online.value = true
})

describe('AskView sending', () => {
    it('shows a question that failed before it started and keeps it in view', async () => {
        const error_handler = vi.fn<ErrorHandler>()

        vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(SCROLL_HEIGHT_PX)

        const wrapper = view_mount(error_handler)

        await flushPromises()

        const suggestion = wrapper.get('.ask-suggestion')

        expect(suggestion.attributes('disabled')).toBeUndefined()

        await suggestion.trigger('click')
        await flushPromises()

        expect(error_handler).not.toHaveBeenCalled()
        expect(wrapper.get('.ask-problem').text()).toContain('remi could not load its AI service.')
        expect(wrapper.get('.ask-scroll').element.scrollTop).toBe(SCROLL_HEIGHT_PX)
    })
})

describe('AskView thread scroll', () => {
    it('keeps a thread pulled past its top at the top for the next visit', async () => {
        const error_handler = vi.fn<ErrorHandler>()

        vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(SCROLL_HEIGHT_PX)
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(SCROLL_CLIENT_PX)
        ask_state.exchanges.value = [exchange_done('Who drafts the banner copy?')]

        const first = view_mount(error_handler)

        await flushPromises()

        const scroller = first.get('.ask-scroll')

        scroller.element.scrollTop = -24
        await scroller.trigger('scroll')
        first.unmount()

        expect(ask_state.thread_scroll.value).toEqual({
            chat_id: ask_state.chat_id.value,
            top_px: 0,
        })

        const second = view_mount(error_handler)

        await flushPromises()

        expect(error_handler).not.toHaveBeenCalled()
        expect(ask_state.thread_scroll.value).toBeNull()
        expect(second.get('.ask-scroll').element.scrollTop).toBe(0)
        expect(second.find('.ask-jump').exists()).toBe(true)
    })
})

describe('AskView scope', () => {
    it('names a meeting whose file name is only a dot and an extension', async () => {
        const error_handler = vi.fn<ErrorHandler>()
        const meeting = job_listing_build({ source_path: '/home/you/.wav' })

        vi.mocked(ipc.jobs_list).mockResolvedValue([meeting])
        jobs.value = [meeting]
        ask_state.scope.value = { kind: 'meeting', job_id: meeting.id }

        const wrapper = view_mount(error_handler)

        await flushPromises()

        expect(error_handler).not.toHaveBeenCalled()
        expect(wrapper.get('.ask-scope').text()).toBe('.wav')
    })
})
