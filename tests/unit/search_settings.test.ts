import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SearchSettings from '../../src/components/search_settings.vue'
import { use_settings } from '../../src/composables/use_settings'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, PROPERTIES, TO_FAKE } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { SearchStatus, Settings } from '../../src/types'


vi.mock('../../src/lib/ipc')

const API_HOST = 'https://api.example.test'
const MODEL = 'qwen3-embedding:0.6b'
const MODEL_DEFAULT = 'stratus.embed'
const POLL_MS = 1500
const SELECTOR_HOST = 'input[type="url"]'
const SELECTOR_MODEL = 'input[type="text"]'

const SETTINGS_EMPTY = Object.freeze<Settings>({
    notes_template_id_default: null,
    theme: null,
    palette: null,
    recordings_directory: null,
    notes_model: null,
    notes_thinking: null,
    api_host: null,
    jobs_view: null,
    embeddings_host: null,
    embeddings_model: null,
})

const mounted = new Set<VueWrapper>()
const settings_state = use_settings()

async function mount_settings(model: string | null): Promise<VueWrapper> {
    assert(model === null || model.trim() === model)
    assert(mounted.size === 0)

    settings_state.settings.value = { ...SETTINGS_EMPTY, embeddings_model: model }

    const wrapper = mount(SearchSettings, {
        [PROPERTIES]: { api_host: API_HOST },
        [ATTACH_TO]: document.body,
    })

    mounted.add(wrapper)
    await flushPromises()

    return wrapper
}

function status_build(patch: Partial<SearchStatus>): SearchStatus {
    assert(typeof patch === 'object')

    const built = {
        error: null,
        model: MODEL,
        model_default: MODEL_DEFAULT,
        passages: 40,
        passages_embedded: 40,
        ...patch,
    }

    assert(built.passages_embedded <= built.passages)

    return built
}

beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers({ [TO_FAKE]: ['setInterval', 'clearInterval'] })
    vi.mocked(ipc.settings_update).mockResolvedValue(undefined)
    vi.mocked(ipc.search_vectors_refresh).mockResolvedValue(undefined)
    settings_state.error_message.value = null
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    vi.useRealTimers()
    document.body.innerHTML = ''
})

describe('SearchSettings status', () => {
    it('counts the passages ready by meaning until the model catches up', async () => {
        vi.mocked(ipc.search_status).mockResolvedValue(status_build({ passages_embedded: 12 }))

        const wrapper = await mount_settings(MODEL)

        expect(wrapper.text()).toContain(
            'Ask can search 12 of 40 passages by meaning. The rest are being prepared.',
        )

        vi.mocked(ipc.search_status).mockResolvedValue(status_build({}))
        vi.advanceTimersByTime(POLL_MS)
        await flushPromises()

        expect(wrapper.text()).toContain('Ask can search all 40 passages by meaning.')
        expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    })

    it('shows the default model and follows its progress when none is chosen', async () => {
        const preparing = status_build({ model: MODEL_DEFAULT, passages_embedded: 12 })

        vi.mocked(ipc.search_status).mockResolvedValue(preparing)

        const wrapper = await mount_settings(null)

        expect(wrapper.get<HTMLInputElement>(SELECTOR_MODEL).element.value).toBe(MODEL_DEFAULT)
        expect(wrapper.text()).toContain('Ask can search 12 of 40 passages by meaning.')

        vi.advanceTimersByTime(POLL_MS)
        await flushPromises()

        expect(ipc.search_status).toHaveBeenCalledTimes(2)
    })

    it('stays quiet and skips polling while the search model is off', async () => {
        const off = status_build({ model: null, passages_embedded: 0 })

        vi.mocked(ipc.search_status).mockResolvedValue(off)

        const wrapper = await mount_settings('')

        expect(wrapper.get(SELECTOR_MODEL).attributes('placeholder')).toBe('Off')
        expect(wrapper.get(SELECTOR_HOST).attributes('placeholder')).toBe(API_HOST)

        vi.advanceTimersByTime(POLL_MS * 3)
        await flushPromises()

        expect(ipc.search_status).toHaveBeenCalledTimes(1)
        expect(wrapper.text()).not.toContain('by meaning')
    })

    it('stops polling once it leaves the page', async () => {
        vi.mocked(ipc.search_status).mockResolvedValue(status_build({}))

        const wrapper = await mount_settings(MODEL)

        vi.advanceTimersByTime(POLL_MS)
        await flushPromises()

        expect(ipc.search_status).toHaveBeenCalledTimes(2)

        wrapper.unmount()
        mounted.delete(wrapper)
        vi.advanceTimersByTime(POLL_MS * 4)
        await flushPromises()

        expect(ipc.search_status).toHaveBeenCalledTimes(2)
    })
})

describe('SearchSettings fields', () => {
    it('saves a model and address, turns off when cleared, and restores the default', async () => {
        const off = status_build({ model: null, passages_embedded: 0 })

        vi.mocked(ipc.search_status).mockResolvedValue(off)

        const wrapper = await mount_settings('')
        const model = wrapper.get<HTMLInputElement>(SELECTOR_MODEL)

        await model.setValue(`  ${MODEL}  `)
        await model.trigger('blur')
        await flushPromises()

        expect(ipc.settings_update).toHaveBeenLastCalledWith({
            ...SETTINGS_EMPTY,
            embeddings_model: MODEL,
        })

        expect(model.element.value).toBe(MODEL)

        const host = wrapper.get<HTMLInputElement>(SELECTOR_HOST)

        await host.setValue(' http://localhost:11434 ')
        await host.trigger('blur')
        await flushPromises()

        expect(settings_state.settings.value.embeddings_host).toBe('http://localhost:11434')

        await model.setValue('')
        await model.trigger('blur')
        await flushPromises()

        expect(settings_state.settings.value.embeddings_model).toBe('')

        await model.setValue(MODEL_DEFAULT)
        await model.trigger('blur')
        await flushPromises()

        expect(settings_state.settings.value.embeddings_model).toBeNull()
        expect(ipc.settings_update).toHaveBeenCalledTimes(4)
    })

    it('leaves the settings alone when a field is left unchanged', async () => {
        vi.mocked(ipc.search_status).mockResolvedValue(status_build({}))

        const wrapper = await mount_settings(MODEL)
        const model = wrapper.get<HTMLInputElement>(SELECTOR_MODEL)

        await model.setValue(` ${MODEL} `)
        await model.trigger('blur')
        await flushPromises()

        expect(ipc.settings_update).not.toHaveBeenCalled()
        expect(model.element.value).toBe(MODEL)
    })

    it('leaves the default alone when its field is left unchanged', async () => {
        vi.mocked(ipc.search_status).mockResolvedValue(status_build({ model: MODEL_DEFAULT }))

        const wrapper = await mount_settings(null)
        const model = wrapper.get<HTMLInputElement>(SELECTOR_MODEL)

        await model.trigger('blur')
        await flushPromises()

        expect(ipc.settings_update).not.toHaveBeenCalled()
        expect(model.element.value).toBe(MODEL_DEFAULT)
    })
})

describe('SearchSettings failure', () => {
    it('reports a failure and clears it while the worker tries again', async () => {
        const failure = 'network error: error sending request for url'

        vi.mocked(ipc.search_status).mockResolvedValue(status_build({ error: failure }))

        const wrapper = await mount_settings(MODEL)
        const alert = wrapper.get('[role="alert"]')

        expect(alert.text()).toContain('The search model could not prepare passages.')
        expect(alert.text()).toContain('The server could not be reached.')
        expect(wrapper.text()).not.toContain('by meaning')

        await wrapper.get('button.btn-default').trigger('click')
        await flushPromises()

        expect(ipc.search_vectors_refresh).toHaveBeenCalledTimes(1)
        expect(wrapper.find('[role="alert"]').exists()).toBe(false)
        expect(wrapper.text()).toContain('Ask can search all 40 passages by meaning.')
    })
})
