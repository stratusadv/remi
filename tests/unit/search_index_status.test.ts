import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import SearchIndexStatus from '../../src/components/search_index_status.vue'
import { use_settings } from '../../src/composables/use_settings'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, TO_FAKE, mount_auto_unmount } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { SearchStatus } from '../../src/types'


vi.mock('../../src/lib/ipc')

const POLL_MS = 1500
const settings_state = use_settings()

async function mount_status(): Promise<VueWrapper> {
    assert(document.body.childElementCount === 0)

    const wrapper = mount_auto_unmount(SearchIndexStatus, { [ATTACH_TO]: document.body })

    await flushPromises()

    assert(wrapper.vm.$.isMounted)

    return wrapper
}

function status_build(patch: Partial<SearchStatus>): SearchStatus {
    assert(typeof patch === 'object')

    const built = { error: null, passages: 40, passages_embedded: 40, ...patch }

    assert(built.passages_embedded <= built.passages)

    return built
}

beforeEach(() => {
    onTestFinished(() => {
        vi.useRealTimers()
        document.body.innerHTML = ''
    })

    vi.resetAllMocks()
    vi.useFakeTimers({ [TO_FAKE]: ['setInterval', 'clearInterval'] })
    vi.mocked(ipc.search_vectors_refresh).mockResolvedValue(undefined)
    settings_state.error_message.value = null
})

describe('SearchIndexStatus progress', () => {
    it('counts the passages ready by meaning and hides once the index catches up', async () => {
        vi.mocked(ipc.search_status).mockResolvedValue(status_build({ passages_embedded: 12 }))

        const wrapper = await mount_status()

        expect(wrapper.text()).toContain(
            'Ask can search 12 of 40 passages by meaning. The rest are being prepared.',
        )

        vi.mocked(ipc.search_status).mockResolvedValue(status_build({}))
        vi.advanceTimersByTime(POLL_MS)
        await flushPromises()

        expect(wrapper.text()).toBe('')
        expect(wrapper.find('h3').exists()).toBe(false)
    })

    it('stays hidden while there is nothing to search', async () => {
        const empty = status_build({ passages: 0, passages_embedded: 0 })

        vi.mocked(ipc.search_status).mockResolvedValue(empty)

        const wrapper = await mount_status()

        expect(wrapper.text()).toBe('')
        expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    })

    it('stops polling once it leaves the page', async () => {
        vi.mocked(ipc.search_status).mockResolvedValue(status_build({}))

        const wrapper = await mount_status()

        vi.advanceTimersByTime(POLL_MS)
        await flushPromises()

        expect(ipc.search_status).toHaveBeenCalledTimes(2)

        wrapper.unmount()
        vi.advanceTimersByTime(POLL_MS * 4)
        await flushPromises()

        expect(ipc.search_status).toHaveBeenCalledTimes(2)
    })
})

describe('SearchIndexStatus failure', () => {
    it('reports a failure and clears it while the worker tries again', async () => {
        const failure = 'network error: error sending request for url'
        const failed = status_build({ error: failure, passages_embedded: 12 })

        vi.mocked(ipc.search_status).mockResolvedValue(failed)

        const wrapper = await mount_status()
        const alert = wrapper.get('[role="alert"]')

        expect(alert.text()).toContain('The search model could not prepare passages.')
        expect(alert.text()).toContain('The server could not be reached.')
        expect(wrapper.text()).not.toContain('by meaning')

        await wrapper.get('button.btn-default').trigger('click')
        await flushPromises()

        expect(ipc.search_vectors_refresh).toHaveBeenCalledTimes(1)
        expect(wrapper.find('[role="alert"]').exists()).toBe(false)
        expect(wrapper.text()).toContain('Ask can search 12 of 40 passages by meaning.')
    })

    it('stops polling and reports it when the status cannot be read', async () => {
        vi.mocked(ipc.search_status).mockRejectedValue(new Error('The search index is locked.'))

        const wrapper = await mount_status()

        expect(settings_state.error_message.value).toContain('The search index is locked.')
        expect(wrapper.text()).toBe('')

        vi.advanceTimersByTime(POLL_MS * 3)
        await flushPromises()

        expect(ipc.search_status).toHaveBeenCalledTimes(1)
    })
})
