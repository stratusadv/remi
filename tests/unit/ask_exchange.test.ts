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
