import { listen } from '@tauri-apps/api/event'
import { TextSelection } from '@tiptap/pm/state'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { KeepAlive, h, ref } from 'vue'
import StepNotes from '../../src/components/step_notes.vue'
import { use_dialog } from '../../src/composables/use_dialog'
import { use_endpoints } from '../../src/composables/use_endpoints'
import { use_notes_templates } from '../../src/composables/use_notes_templates'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import {
    ATTACH_TO,
    CTRL_KEY,
    TO_FAKE,
    deferred_new,
    editor_of,
    job_meta_build,
    mount_auto_unmount,
    transcript_build,
} from './fixtures'
import type { Event, EventCallback, UnlistenFn } from '@tauri-apps/api/event'
import type { Editor } from '@tiptap/core'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import type { ComponentOptions, Ref } from 'vue'
import type {
    APIEndpoint,
    ChatChunk,
    JobID,
    JobMeta,
    Markdown,
    StreamID,
} from '../../src/types'


vi.mock('../../src/lib/ipc')
vi.mock('@tauri-apps/api/event')
vi.mock('@tauri-apps/plugin-dialog')

const MARKDOWN = 'First paragraph\n\n- item one\n- item two'
const MARKDOWN_EDITED = 'Very First paragraph\n\n- item one\n- item two'
const NOTES_SECOND = 'Second meeting notes'
const INSTRUCTION_REWRITE = 'Rewrite this more clearly and concisely. Keep the same meaning.'

const ENDPOINT_NOTES = Object.freeze<APIEndpoint>({
    id: 'notes-ep',
    name: 'Notes',
    purpose: 'notes',
    host: 'https://ai.example.invalid',
    api_key: '',
    model: 'thinking',
    temperature: null,
    output_tokens_max: null,
    api_path_chat: null,
    api_path_transcribe: null,
    transcribe_verbose: null,
    transcribe_chunk_seconds: null,
    has_api_key: true,
})

const pipeline = use_pipeline()
const { endpoints } = use_endpoints()
const { templates } = use_notes_templates()
const { close: dialog_close } = use_dialog()
const unlisten = vi.fn<UnlistenFn>()


type PositionFrom = number
type PositionTo = number

interface NotesHarness {
    wrapper: VueWrapper
    editor: Editor
}

class ResizeObserverStub {
    disconnect = vi.fn()
    observe = vi.fn()
}

async function ai_open(wrapper: VueWrapper): Promise<void> {
    assert(wrapper.exists())

    await wrapper.get('.rich-tb-btn-ai').trigger('click')

    assert(wrapper.find('.rich-editor-ai').exists())
}

function banner_texts(): string[] {
    const banners = [...document.body.querySelectorAll('.banner p')]

    assert(banners.length <= 2)
    assert(banners.every((banner) => banner.isConnected))

    return banners.map((banner) => banner.textContent.trim())
}

function button_named(wrapper: VueWrapper, label: string): DOMWrapper<HTMLButtonElement> {
    assert(wrapper.exists())
    assert(label.length > 0)

    const button = wrapper.findAll('button').find((candidate) => candidate.text() === label)

    if (button === undefined) throw new Error(`no ${label} button`)

    assert(button.attributes('disabled') === undefined)

    return button
}

function chunk_event(stream_id: StreamID, text: Markdown, done: boolean): Event<ChatChunk> {
    assert(stream_id.length > 0)
    assert(typeof text === 'string')

    return { event: 'notes_generate_chunk', id: 1, payload: { stream_id, text, done } }
}

async function editor_shown(wrapper: VueWrapper): Promise<Editor> {
    assert(wrapper.exists())

    const element = await vi.waitFor(
        () => wrapper.get('.ProseMirror').element,
        { timeout: 10_000 },
    )

    assert(element.isConnected)

    return editor_of(element)
}

async function generation_start(wrapper: VueWrapper): Promise<EventCallback<ChatChunk>> {
    assert(wrapper.exists())

    const regenerate = wrapper.findAll('button').find(
        (candidate) => candidate.text() === 'Regenerate notes',
    )

    if (regenerate === undefined) throw new Error('no Regenerate notes button')

    assert(regenerate.attributes('disabled') === undefined)

    await regenerate.trigger('click')
    dialog_close(true)
    await flushPromises()

    const listener = vi.mocked(listen).mock.calls.at(-1)?.[1]

    if (listener === undefined) throw new Error('the generation registered no chunk listener')

    return listener
}

function generation_stream_id(): StreamID {
    const stream_id = vi.mocked(ipc.notes_generate_remote_streaming).mock.calls[0]?.[0]

    assert(stream_id !== undefined, 'the generation never reached the backend')
    assert(stream_id.length > 0)

    return stream_id
}

function keep_alive_host(shown: Ref<boolean>): ComponentOptions {
    assert(typeof shown.value === 'boolean')
    assert(typeof StepNotes === 'object')

    return {
        render() {
            assert(typeof shown.value === 'boolean')

            return h(
                KeepAlive,
                { include: 'step_notes', max: 1 },
                () => (shown.value ? h(StepNotes, { key: 'notes-0' }) : null),
            )
        },
    }
}

async function meeting_open(job_id: JobID): Promise<void> {
    assert(job_id.length > 0)
    assert(!pipeline.job_open_busy.value)

    vi.mocked(ipc.job_transcript_engines_list).mockResolvedValue([])
    vi.mocked(ipc.job_waveform_get).mockResolvedValue(null)
    vi.mocked(ipc.notes_load).mockImplementation(notes_on_disk)

    await pipeline.job_open(job_meta_build({ id: job_id }), 'notes')
    await flushPromises()

    assert(pipeline.job_id_current.value === job_id)
}

async function mount_notes(): Promise<NotesHarness> {
    assert(document.body.childElementCount === 0)
    assert(Array.isArray(endpoints.value))

    const wrapper = mount_auto_unmount(StepNotes, { [ATTACH_TO]: document.body })

    const element = await vi.waitFor(
        () => wrapper.get('.ProseMirror').element,
        { timeout: 10_000 },
    )

    return { wrapper, editor: editor_of(element) }
}

async function mount_notes_kept_alive(shown: Ref<boolean>): Promise<NotesHarness> {
    assert(shown.value)
    assert(document.body.childElementCount === 0)

    const wrapper = mount_auto_unmount(keep_alive_host(shown), { [ATTACH_TO]: document.body })

    return { wrapper, editor: await editor_shown(wrapper) }
}

async function notes_on_disk(job_id: JobID): Promise<Markdown | null> {
    assert(job_id.length > 0)
    assert(vi.isMockFunction(ipc.notes_save))

    const saves = vi.mocked(ipc.notes_save).mock.calls.filter(([saved]) => saved === job_id)
    const saved_last = saves.at(-1)?.[1]

    if (saved_last !== undefined) return Promise.resolve(saved_last)

    return Promise.resolve(job_id === 'job-1' ? MARKDOWN : NOTES_SECOND)
}

async function quick_rewrite(wrapper: VueWrapper): Promise<void> {
    assert(wrapper.exists())

    const button = wrapper.findAll('.rich-editor-ai-actions button').find(
        (candidate) => candidate.text() === 'Rewrite',
    )

    if (button === undefined) throw new Error('no Rewrite quick action')

    assert(button.attributes('disabled') === undefined)

    await button.trigger('click')
    await flushPromises()
}

function select(editor: Editor, from: PositionFrom, to: PositionTo): void {
    assert(from >= 0)
    assert(to >= from)
    assert(editor.isEditable)

    editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
    )
}

beforeEach(() => {
    onTestFinished(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
        vi.useRealTimers()
        document.body.innerHTML = ''
    })

    vi.resetAllMocks()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(listen).mockResolvedValue(unlisten)
    vi.mocked(ipc.job_meta_get).mockResolvedValue(null)
    vi.mocked(ipc.notes_save).mockResolvedValue(undefined)
    vi.mocked(ipc.notes_text_rewrite_streaming).mockResolvedValue('Rewritten')

    vi.mocked(ipc.markdown_render_html).mockImplementation(
        async (markdown) => Promise.resolve(`<p>${markdown}</p>`),
    )

    pipeline.pipeline_reset()
    pipeline.job_id_current.value = 'job-1'
    pipeline.transcript.value = transcript_build(['hello'])
    pipeline.notes_markdown.value = MARKDOWN
    pipeline.template_id_selected.value = 'meeting'

    templates.value = [
        { id: 'meeting', name: 'Meeting', description: '', instructions: '', edited: false },
    ]

    endpoints.value = [ENDPOINT_NOTES]
})

describe('StepNotes AI rewrite handler', () => {
    it('sends a selection without the template', async () => {
        const { wrapper, editor } = await mount_notes()

        select(editor, 1, 16)
        await ai_open(wrapper)
        await quick_rewrite(wrapper)

        expect(ipc.notes_text_rewrite_streaming).toHaveBeenCalledTimes(1)

        expect(ipc.notes_text_rewrite_streaming).toHaveBeenCalledWith(
            expect.stringMatching(/^[0-9a-f-]{36}$/u),
            'notes-ep',
            'First paragraph',
            INSTRUCTION_REWRITE,
            null,
        )

        expect(pipeline.notes_markdown.value).toBe('Rewritten\n\n- item one\n- item two')
    })

    it('sends the whole document with the selected template', async () => {
        const { wrapper } = await mount_notes()

        await ai_open(wrapper)
        await quick_rewrite(wrapper)

        expect(ipc.notes_text_rewrite_streaming).toHaveBeenCalledWith(
            expect.stringMatching(/^[0-9a-f-]{36}$/u),
            'notes-ep',
            MARKDOWN,
            INSTRUCTION_REWRITE,
            'meeting',
        )

        expect(pipeline.notes_markdown.value).toBe('Rewritten')
    })

    it('applies streamed chunks for its own stream id and stops listening afterwards', async () => {
        vi.mocked(ipc.notes_text_rewrite_streaming).mockImplementation(async (stream_id) => {
            const calls = vi.mocked(listen).mock.calls
            const chunk_listener = calls[calls.length - 1]?.[1]

            if (chunk_listener === undefined) throw new Error('no chunk listener registered')

            chunk_listener(chunk_event('someone-else', 'ignored', false))
            chunk_listener(chunk_event(stream_id, 'Stream', false))
            chunk_listener(chunk_event(stream_id, 'ed', false))
            chunk_listener(chunk_event(stream_id, 'not this', true))

            return Promise.resolve('')
        })

        const { wrapper } = await mount_notes()

        await ai_open(wrapper)
        await quick_rewrite(wrapper)

        expect(vi.mocked(listen).mock.calls).toHaveLength(1)
        expect(vi.mocked(listen).mock.calls[0]?.[0]).toBe('notes_generate_chunk')
        expect(unlisten).toHaveBeenCalledTimes(1)
        expect(pipeline.notes_markdown.value).toBe('Streamed')
    })
})

describe('StepNotes AI rewrite handler', () => {
    it('reports a missing notes endpoint in the editor without calling the backend', async () => {
        endpoints.value = []

        const { wrapper } = await mount_notes()

        await ai_open(wrapper)
        await quick_rewrite(wrapper)

        expect(ipc.notes_text_rewrite_streaming).not.toHaveBeenCalled()

        expect(wrapper.get('.rich-editor-ai-error').text())
            .toBe('remi could not load its AI service. Restart remi and try again.')
    })
})

describe('StepNotes saving', () => {
    it('autosaves one second after the notes change', async () => {
        const { editor } = await mount_notes()

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        editor.commands.insertContentAt(1, 'Very ')
        await flushPromises()

        expect(pipeline.notes_markdown.value).toBe('Very First paragraph\n\n- item one\n- item two')
        expect(ipc.notes_save).not.toHaveBeenCalled()

        vi.advanceTimersByTime(999)
        await flushPromises()

        expect(ipc.notes_save).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        await flushPromises()

        expect(ipc.notes_save).toHaveBeenCalledWith(
            'job-1',
            'Very First paragraph\n\n- item one\n- item two',
        )
    })

    it('saves immediately on ctrl+s', async () => {
        await mount_notes()

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', [CTRL_KEY]: true }))
        await flushPromises()

        expect(ipc.notes_save).toHaveBeenCalledWith('job-1', MARKDOWN)
    })

    it('saves an edit made just before the view closes, even once the meeting closed', async () => {
        const { wrapper, editor } = await mount_notes()

        editor.commands.insertContentAt(1, 'Very ')
        await flushPromises()
        pipeline.pipeline_reset()
        wrapper.unmount()
        await flushPromises()

        expect(ipc.notes_save).toHaveBeenCalledExactlyOnceWith('job-1', MARKDOWN_EDITED)
    })
})

describe('StepNotes generation', () => {
    afterEach(() => {
        pipeline.notes_generations.value = []
    })

    it('saves a generation to its own meeting after another meeting has opened', async () => {
        const finished = deferred_new<Markdown>()

        vi.mocked(ipc.notes_generate_remote_streaming).mockReturnValue(finished.promise)

        const { wrapper } = await mount_notes()
        const chunk = await generation_start(wrapper)
        const stream_id = generation_stream_id()

        chunk(chunk_event(stream_id, 'Draft', false))

        expect(pipeline.notes_markdown.value).toBe('Draft')

        pipeline.job_id_current.value = 'job-2'
        pipeline.notes_markdown.value = 'Second meeting notes'
        chunk(chunk_event(stream_id, ' notes', false))
        finished.resolve('Draft notes')
        await flushPromises()

        expect(pipeline.notes_markdown.value).toBe('Second meeting notes')
        expect(pipeline.notes_generations.value).toEqual([])
        expect(ipc.notes_save).toHaveBeenCalledWith('job-1', 'Draft notes')
        expect(ipc.notes_save).not.toHaveBeenCalledWith('job-2', 'Draft notes')
    })

    it('shows a generation still running when its meeting opens again', async () => {
        const finished = deferred_new<Markdown>()

        vi.mocked(ipc.notes_generate_remote_streaming).mockReturnValue(finished.promise)

        const first = await mount_notes()
        const chunk = await generation_start(first.wrapper)
        const stream_id = generation_stream_id()

        chunk(chunk_event(stream_id, 'Half', false))
        first.wrapper.unmount()

        const second = mount_auto_unmount(StepNotes, { [ATTACH_TO]: document.body })

        chunk(chunk_event(stream_id, ' done', false))
        await flushPromises()

        const regenerate = second.findAll('button').find(
            (candidate) => candidate.text() === 'Regenerating…',
        )

        expect(second.get('.notes-stream-pane').text()).toContain('Half done')
        expect(regenerate?.attributes('disabled')).toBeDefined()

        finished.resolve('Half done')
        await flushPromises()

        expect(second.find('.notes-stream-pane').exists()).toBe(false)
        expect(ipc.notes_save).toHaveBeenCalledExactlyOnceWith('job-1', 'Half done')
    })
})

describe('StepNotes generation', () => {
    afterEach(() => {
        pipeline.notes_generations.value = []
    })

    it('abandons a generation confirmed after another meeting has opened', async () => {
        const finished = deferred_new<Markdown>()

        vi.mocked(ipc.notes_generate_remote_streaming).mockReturnValue(finished.promise)

        const { wrapper } = await mount_notes()

        await button_named(wrapper, 'Regenerate notes').trigger('click')
        await meeting_open('job-2')
        dialog_close(true)
        await flushPromises()

        expect(ipc.notes_generate_remote_streaming).not.toHaveBeenCalled()
        expect(pipeline.notes_generations.value).toEqual([])
        expect(pipeline.notes_markdown.value).toBe(NOTES_SECOND)
        expect(wrapper.get('.ProseMirror').text()).toBe(NOTES_SECOND)
    })

    it('shows a generation that finished while it was away and saves it once', async () => {
        const finished = deferred_new<Markdown>()
        const shown = ref(true)

        vi.mocked(ipc.notes_generate_remote_streaming).mockReturnValue(finished.promise)

        const { wrapper } = await mount_notes_kept_alive(shown)

        await generation_start(wrapper)
        shown.value = false
        await flushPromises()
        finished.resolve('Draft notes')
        await flushPromises()

        expect(document.body.querySelector('.notes-stream-pane')).toBeNull()

        shown.value = true

        const editor = await editor_shown(wrapper)

        expect(editor.getText()).toBe('Draft notes')
        expect(pipeline.notes_generations.value).toEqual([])
        expect(ipc.notes_save).toHaveBeenCalledExactlyOnceWith('job-1', 'Draft notes')
    })
})

describe('StepNotes lifecycle', () => {
    it('adds no document listener after it closes while the meeting details load', async () => {
        const meta = deferred_new<JobMeta | null>()

        vi.mocked(ipc.job_meta_get).mockReturnValue(meta.promise)

        const wrapper = mount_auto_unmount(StepNotes, { [ATTACH_TO]: document.body })
        const added = vi.spyOn(document, 'addEventListener')

        wrapper.unmount()
        meta.resolve(null)
        await flushPromises()

        expect(added).not.toHaveBeenCalled()
    })
})

describe('StepNotes meeting switch', () => {
    it('saves a pending edit to its own meeting as soon as another opens', async () => {
        const { editor } = await mount_notes()

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        editor.commands.insertContentAt(1, 'Very ')
        await flushPromises()
        await meeting_open('job-2')

        expect(ipc.notes_save).toHaveBeenCalledExactlyOnceWith('job-1', MARKDOWN_EDITED)

        vi.advanceTimersByTime(1000)
        await flushPromises()

        expect(ipc.notes_save).toHaveBeenCalledExactlyOnceWith('job-1', MARKDOWN_EDITED)
    })

    it('never brings the previous meeting notes back on undo', async () => {
        const { wrapper } = await mount_notes()

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        await meeting_open('job-2')

        const editor = editor_of(wrapper.get('.ProseMirror').element)

        expect(editor.getText()).toBe(NOTES_SECOND)

        editor.commands.undo()
        await flushPromises()
        vi.advanceTimersByTime(1000)
        await flushPromises()

        expect(pipeline.notes_markdown.value).toBe(NOTES_SECOND)
        expect(editor.getText()).toBe(NOTES_SECOND)
        expect(ipc.notes_save).not.toHaveBeenCalled()
    })
})

describe('StepNotes meeting switch', () => {
    it('drops an AI rewrite that finishes after another meeting has opened', async () => {
        const reply = deferred_new<string>()

        vi.mocked(ipc.notes_text_rewrite_streaming).mockReturnValue(reply.promise)

        const { wrapper } = await mount_notes()

        await ai_open(wrapper)
        await quick_rewrite(wrapper)
        await meeting_open('job-2')
        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        reply.resolve('Rewritten')
        await flushPromises()
        vi.advanceTimersByTime(1000)
        await flushPromises()

        expect(pipeline.notes_markdown.value).toBe(NOTES_SECOND)
        expect(wrapper.get('.ProseMirror').text()).toBe(NOTES_SECOND)
        expect(ipc.notes_save).not.toHaveBeenCalled()
    })

    it('prints the meeting it was asked to print after another has opened', async () => {
        const saved = deferred_new<undefined>()
        const { wrapper, editor } = await mount_notes()

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        vi.mocked(ipc.notes_save).mockReturnValueOnce(saved.promise)
        vi.mocked(ipc.notes_print).mockResolvedValue(undefined)
        editor.commands.insertContentAt(1, 'Very ')
        await flushPromises()
        await wrapper.get('.export-menu-trigger').trigger('click')
        await wrapper.findAll('.menu-item')[0]?.trigger('click')

        expect(ipc.notes_save).toHaveBeenCalledExactlyOnceWith('job-1', MARKDOWN_EDITED)

        await meeting_open('job-2')
        saved.resolve(undefined)
        await flushPromises()

        expect(ipc.notes_print).toHaveBeenCalledExactlyOnceWith('job-1')
    })
})

describe('StepNotes kept alive', () => {
    it('keeps an edit made just before leaving when the same meeting opens again', async () => {
        const shown = ref(true)
        const { editor } = await mount_notes_kept_alive(shown)

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        editor.commands.insertContentAt(1, 'Very ')
        await flushPromises()
        shown.value = false
        await flushPromises()
        await meeting_open('job-1')
        shown.value = true
        await flushPromises()

        expect(pipeline.notes_markdown.value).toBe(MARKDOWN_EDITED)
        expect(editor.getText()).toContain('Very First paragraph')
        expect(ipc.notes_save).toHaveBeenCalledExactlyOnceWith('job-1', MARKDOWN_EDITED)
    })

    it('shows and saves only the meeting that opened while it was away', async () => {
        const shown = ref(true)
        const { wrapper } = await mount_notes_kept_alive(shown)

        shown.value = false
        await flushPromises()
        await meeting_open('job-2')
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', [CTRL_KEY]: true }))
        await flushPromises()

        expect(ipc.notes_save).not.toHaveBeenCalled()

        shown.value = true

        const editor = await editor_shown(wrapper)

        expect(editor.getText()).toBe(NOTES_SECOND)

        editor.commands.undo()
        await flushPromises()
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', [CTRL_KEY]: true }))
        await flushPromises()

        expect(pipeline.notes_markdown.value).toBe(NOTES_SECOND)
        expect(ipc.notes_save).toHaveBeenCalledExactlyOnceWith('job-2', NOTES_SECOND)
    })
})

describe('StepNotes kept alive', () => {
    it('saves an AI rewrite that finished while it was away', async () => {
        const reply = deferred_new<string>()
        const shown = ref(true)

        vi.mocked(ipc.notes_text_rewrite_streaming).mockReturnValue(reply.promise)

        const { wrapper } = await mount_notes_kept_alive(shown)

        await ai_open(wrapper)
        await quick_rewrite(wrapper)
        shown.value = false
        await flushPromises()
        reply.resolve('Rewritten')
        await flushPromises()

        expect(pipeline.notes_markdown.value).toBe('Rewritten')
        expect(ipc.notes_save).toHaveBeenCalledExactlyOnceWith('job-1', 'Rewritten')
    })

    it('reads the meeting details again each time it is shown', async () => {
        const shown = ref(true)

        await mount_notes_kept_alive(shown)

        expect(ipc.job_meta_get).toHaveBeenCalledExactlyOnceWith('job-1')

        vi.mocked(ipc.job_meta_get).mockResolvedValue(job_meta_build({ title: 'Renamed sync' }))
        shown.value = false
        await flushPromises()
        shown.value = true
        await flushPromises()

        expect(ipc.job_meta_get).toHaveBeenCalledTimes(2)
        expect(pipeline.meta_current.value?.title).toBe('Renamed sync')
    })
})

describe('StepNotes kept alive', () => {
    it('forgets an open export menu and an error once it is left', async () => {
        const shown = ref(true)

        vi.mocked(ipc.notes_save).mockRejectedValue(new Error('disk full'))

        const { wrapper } = await mount_notes_kept_alive(shown)

        expect(banner_texts()).toEqual([])

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', [CTRL_KEY]: true }))
        await flushPromises()
        dialog_close(true)
        await wrapper.get('.export-menu-trigger').trigger('click')

        expect(banner_texts()).toEqual(['disk full'])
        expect(wrapper.find('.menu-popover').exists()).toBe(true)

        shown.value = false
        await flushPromises()
        shown.value = true
        await flushPromises()

        expect(banner_texts()).toEqual([])
        expect(wrapper.find('.menu-popover').exists()).toBe(false)
    })
})
