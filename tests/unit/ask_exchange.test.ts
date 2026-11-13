import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AskExchange from '../../src/components/ask_exchange.vue'
import { use_context_menu } from '../../src/composables/use_context_menu'
import { assert } from '../../src/lib/assert'
import { ATTACH_TO, PROPERTIES } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { Exchange } from '../../src/composables/use_ask'


vi.mock('../../src/lib/ipc')

const context_menu = use_context_menu()
const mounted = new Set<VueWrapper>()


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

async function menu_ids(wrapper: VueWrapper): Promise<string[] | null> {
    assert(mounted.has(wrapper))

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

    const wrapper = mount(AskExchange, {
        [PROPERTIES]: { exchange: exchange_build(patch), last },
        [ATTACH_TO]: document.body,
    })

    mounted.add(wrapper)

    return wrapper
}

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    context_menu.close()
    document.body.innerHTML = ''
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
