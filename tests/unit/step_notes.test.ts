import { listen } from '@tauri-apps/api/event'
import { TextSelection } from '@tiptap/pm/state'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StepNotes from '../../src/components/step_notes.vue'
import { use_endpoints } from '../../src/composables/use_endpoints'
import { use_notes_templates } from '../../src/composables/use_notes_templates'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, CTRL_KEY, TO_FAKE, editor_of, transcript_build } from './fixtures'
import type { Event } from '@tauri-apps/api/event'
import type { Editor } from '@tiptap/core'
import type { VueWrapper } from '@vue/test-utils'
import type { APIEndpoint, ChatChunk, Markdown, StreamID } from '../../src/types'


vi.mock('../../src/lib/ipc')
vi.mock('@tauri-apps/api/event')
vi.mock('@tauri-apps/plugin-dialog')

const MARKDOWN = 'First paragraph\n\n- item one\n- item two'
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

const mounted = new Set<VueWrapper>()
const pipeline = use_pipeline()
const { endpoints } = use_endpoints()
const { templates } = use_notes_templates()
const unlisten = vi.fn()


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
    assert(mounted.has(wrapper))

    await wrapper.get('.rich-tb-btn-ai').trigger('click')
}

function chunk_event(stream_id: StreamID, text: Markdown, done: boolean): Event<ChatChunk> {
    assert(stream_id.length > 0)
    assert(typeof text === 'string')

    return { event: 'notes_generate_chunk', id: 1, payload: { stream_id, text, done } }
}

async function mount_notes(): Promise<NotesHarness> {
    assert(mounted.size >= 0)
    assert(Array.isArray(endpoints.value))

    const wrapper = mount(StepNotes, { [ATTACH_TO]: document.body })

    mounted.add(wrapper)

    const element = await vi.waitFor(
        () => wrapper.get('.ProseMirror').element,
        { timeout: 10_000 },
    )

    return { wrapper, editor: editor_of(element) }
}

async function quick_rewrite(wrapper: VueWrapper): Promise<void> {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    const button = wrapper.findAll('.rich-editor-ai-actions button').find(
        (candidate) => candidate.text() === 'Rewrite',
    )

    if (button === undefined) throw new Error('no Rewrite quick action')

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

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
})

describe('StepNotes AI rewrite handler', () => {
    it('sends a selection without the template', async () => {
        const { wrapper, editor } = await mount_notes()

        select(editor, 1, 16)
        await ai_open(wrapper)
        await quick_rewrite(wrapper)

        expect(ipc.notes_text_rewrite_streaming).toHaveBeenCalledTimes(1)

        expect(ipc.notes_text_rewrite_streaming).toHaveBeenCalledWith(
            expect.stringMatching(/^[0-9a-f-]{36}$/),
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
            expect.stringMatching(/^[0-9a-f-]{36}$/),
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

        expect(vi.mocked(listen).mock.calls).toHaveLength(2)
        expect(vi.mocked(listen).mock.calls[1]?.[0]).toBe('notes_generate_chunk')
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
            .toBe('Add your API key under Settings first.')
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
})
