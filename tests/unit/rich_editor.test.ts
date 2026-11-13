import { TextSelection } from '@tiptap/pm/state'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RichEditor from '../../src/components/rich_editor.vue'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import {
    ATTACH_TO,
    CONTENT_RECT,
    EMIT_UPDATE,
    MODEL_VALUE,
    PROPERTIES,
    editor_of,
} from './fixtures'
import type { Editor } from '@tiptap/core'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import type { Mock } from 'vitest'
import type { AIRewriteArgs, AIRewriteHandler } from '../../src/types'


vi.mock('../../src/lib/ipc')

const MARKDOWN = 'First paragraph\n\n- item one\n- item two'

const TITLE_PRESS_OUTSIDE = 'clears the selection on a press outside the editor '
    + 'and keeps it on one inside'

const TITLE_RESIZE_DETACHED = 'ignores a resize while detached '
    + 'and collapses the toolbar on a narrow one once attached'

const mounted = new Set<VueWrapper>()

type PositionFrom = number
type PositionTo = number
type TextFirst = string
type TextLast = string

interface ResizeTarget {
    target: Element
}

type ResizeEntryStub = ResizeTarget & Record<typeof CONTENT_RECT, { width: number }>

type ResizeCallbackStub = (entries: ResizeEntryStub[]) => void

class ResizeObserverStub {
    static callback: ResizeCallbackStub | null = null

    disconnect = vi.fn()
    observe = vi.fn()

    constructor(callback: ResizeCallbackStub) {
        assert(typeof callback === 'function')

        ResizeObserverStub.callback = callback
    }
}

function ai_button(wrapper: VueWrapper): Omit<DOMWrapper<Element>, 'exists'> {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    return wrapper.get('.rich-tb-btn-ai')
}

function ai_meta(wrapper: VueWrapper): string | undefined {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    const metas = wrapper.findAll('.rich-editor-ai-meta')

    return metas[metas.length - 1]?.text()
}

function arm(editor: Editor): void {
    assert(editor.isEditable)

    select(editor, 1, 16)
    editor.view.dispatch(editor.state.tr.insert(16, editor.schema.text('!')))

    expect(editor.state.selection.from).toBe(1)
    expect(editor.state.selection.to).toBe(17)
}

function collapse(editor: Editor, position: number): void {
    assert(position >= 0)
    assert(editor.isEditable)

    editor.view.dispatch(
        editor.state.tr
            .setSelection(TextSelection.create(editor.state.doc, position))
            .setMeta('pointer', true),
    )
}

function editor_from(wrapper: VueWrapper): Editor {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    return editor_of(wrapper.get('.ProseMirror').element)
}

function model_emitted_last(wrapper: VueWrapper): string[] | undefined {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    const calls = wrapper.emitted<string[]>('update:modelValue') ?? []

    return calls[calls.length - 1]
}

async function mount_editor(
    markdown = MARKDOWN,
    ai_rewrite?: AIRewriteHandler,
): Promise<VueWrapper> {
    assert(typeof markdown === 'string')
    assert(ai_rewrite === undefined || typeof ai_rewrite === 'function')

    const properties = { [MODEL_VALUE]: markdown }

    const wrapper = mount(RichEditor, {
        [PROPERTIES]: ai_rewrite !== undefined ? { ...properties, ai_rewrite } : properties,
        [ATTACH_TO]: document.body,
    })

    mounted.add(wrapper)
    await flushPromises()

    return wrapper
}

function quick_action(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
    assert(wrapper.exists())
    assert(label.length > 0)

    const button = wrapper.findAll('.rich-editor-ai-actions button').find(
        (candidate) => candidate.text() === label,
    )

    if (button === undefined) throw new Error(`no quick action labelled ${label}`)

    return button
}

function resize(target: Element, width: number): void {
    assert(width >= 0)
    assert(target instanceof Element)

    ResizeObserverStub.callback?.([{ target, [CONTENT_RECT]: { width } }])
}

function rewrite_handler(reply: string): Mock<(request: AIRewriteArgs) => Promise<string>> {
    assert(typeof reply === 'string')
    assert(mounted.size >= 0)

    return vi.fn(async (request: AIRewriteArgs) => {
        request.on_chunk(reply)

        return Promise.resolve(reply)
    })
}

function select(editor: Editor, from: PositionFrom, to: PositionTo): void {
    assert(from >= 0)
    assert(to >= from)
    assert(editor.isEditable)

    const transaction = editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, from, to),
    )

    editor.view.dispatch(transaction)
}

function text_range(
    editor: Editor,
    first: TextFirst,
    last: TextLast,
): { from: number, to: number } {
    assert(first.length > 0)
    assert(last.length > 0)
    assert(editor.isEditable)

    let from = -1
    let to = -1

    editor.state.doc.descendants((node, position) => {
        if (node.text === first) from = position
        if (node.text === last) to = position + node.nodeSize
    })

    if (from < 0) throw new Error(`text node ${first} not found`)
    if (to < 0) throw new Error(`text node ${last} not found`)

    return { from, to }
}

beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    vi.mocked(ipc.markdown_render_html).mockImplementation(
        async (markdown) => Promise.resolve(`<p>${markdown}</p>`),
    )
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
})

describe('RichEditor mounting', () => {
    it('renders the markdown as a document and reports word and character counts', async () => {
        const wrapper = await mount_editor()
        const editor = editor_from(wrapper)

        expect(editor.getHTML()).toBe(
            '<p>First paragraph</p><ul class="tight" data-tight="true">'
            + '<li><p>item one</p></li><li><p>item two</p></li></ul>',
        )

        expect(wrapper.get('.rich-editor-stats').text()).toContain('8 words')
        const characters = `${String(MARKDOWN.length)} characters`

        expect(wrapper.get('.rich-editor-stats').text()).toContain(characters)
    })

    it('emits markdown when the document changes', async () => {
        const wrapper = await mount_editor()
        const editor = editor_from(wrapper)

        editor.commands.insertContentAt(1, 'Very ')
        await flushPromises()

        expect(model_emitted_last(wrapper)).toEqual([
            'Very First paragraph\n\n- item one\n- item two',
        ])
    })

    it(TITLE_RESIZE_DETACHED, async () => {
        const wrapper = await mount_editor()
        const root = wrapper.get('.rich-editor').element

        root.remove()
        resize(root, 0)
        await flushPromises()

        expect(wrapper.find('[title="More tools"]').exists()).toBe(false)

        document.body.append(root)
        resize(root, 320)
        await flushPromises()

        expect(wrapper.find('[title="More tools"]').exists()).toBe(true)
        const panel = wrapper.get('.rich-tb-more-panel')

        expect(panel.find('[title="Strikethrough"]').exists()).toBe(true)
    })
})

describe('SelectionGuard', () => {
    let now = 0

    beforeEach(() => {
        now = 1_000
        vi.spyOn(performance, 'now').mockImplementation(() => now)
    })

    it('rejects a bare collapse within the window after a doc change with a range', async () => {
        const editor = editor_from(await mount_editor())

        arm(editor)
        now += 100

        editor.view.dispatch(
            editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)),
        )

        expect(editor.state.selection.empty).toBe(false)
        expect(editor.state.selection.from).toBe(1)
        expect(editor.state.selection.to).toBe(17)
    })

    it('accepts a collapse carrying the pointer meta', async () => {
        const editor = editor_from(await mount_editor())

        arm(editor)
        now += 100

        editor.view.dispatch(
            editor.state.tr
                .setSelection(TextSelection.create(editor.state.doc, 3))
                .setMeta('pointer', true),
        )

        expect(editor.state.selection.empty).toBe(true)
        expect(editor.state.selection.from).toBe(3)
    })

    it('accepts a collapse carrying the uiEvent meta or a scrollIntoView marker', async () => {
        const editor = editor_from(await mount_editor())

        arm(editor)
        now += 50

        editor.view.dispatch(
            editor.state.tr
                .setSelection(TextSelection.create(editor.state.doc, 4))
                .setMeta('uiEvent', 'drop'),
        )

        expect(editor.state.selection.from).toBe(4)

        arm(editor)
        now += 50

        editor.view.dispatch(
            editor.state.tr
                .setSelection(TextSelection.create(editor.state.doc, 5))
                .scrollIntoView(),
        )

        expect(editor.state.selection.from).toBe(5)
    })
})

describe('SelectionGuard', () => {
    let now = 0

    beforeEach(() => {
        now = 1_000
        vi.spyOn(performance, 'now').mockImplementation(() => now)
    })

    it('accepts a collapse that also changes the document', async () => {
        const editor = editor_from(await mount_editor())

        arm(editor)
        now += 100

        editor.view.dispatch(
            editor.state.tr
                .setSelection(TextSelection.create(editor.state.doc, 2))
                .insertText('Z', 2, 2),
        )

        expect(editor.state.selection.empty).toBe(true)
        expect(editor.state.doc.textBetween(1, 4)).toBe('FZi')
    })

    it('accepts a bare collapse once the window has passed', async () => {
        const editor = editor_from(await mount_editor())

        arm(editor)
        now += 251

        editor.view.dispatch(
            editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)),
        )

        expect(editor.state.selection.empty).toBe(true)
    })

    it('does not arm on a doc change made with a collapsed selection', async () => {
        const editor = editor_from(await mount_editor())

        select(editor, 2, 2)
        editor.view.dispatch(editor.state.tr.insertText('!', 2, 2))
        select(editor, 1, 10)
        now += 10

        editor.view.dispatch(
            editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)),
        )

        expect(editor.state.selection.empty).toBe(true)
    })

    it('lets a range grow or move while armed', async () => {
        const editor = editor_from(await mount_editor())

        arm(editor)
        now += 10
        select(editor, 2, 8)

        expect(editor.state.selection.from).toBe(2)
        expect(editor.state.selection.to).toBe(8)
    })
})

describe('RichEditor AI rewrite', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    it('follows the selection while the panel is open', async () => {
        const rewrite = rewrite_handler('Rewritten paragraph')
        const wrapper = await mount_editor(MARKDOWN, rewrite)
        const editor = editor_from(wrapper)

        select(editor, 1, 6)
        await ai_button(wrapper).trigger('click')

        expect(ai_meta(wrapper)).toBe('5 characters selected')

        collapse(editor, 20)
        await flushPromises()

        expect(editor.state.selection.empty).toBe(true)
        expect(ai_meta(wrapper)).toBe('Whole document')

        select(editor, 1, 16)
        await flushPromises()

        expect(ai_meta(wrapper)).toBe('15 characters selected')

        await quick_action(wrapper, 'Rewrite').trigger('click')
        await flushPromises()

        expect(rewrite).toHaveBeenCalledTimes(1)

        const request = rewrite.mock.calls[0]?.[0]

        expect(request?.text).toBe('First paragraph')
        expect(request?.whole_document).toBe(false)

        expect(request?.instruction).toBe(
            'Rewrite this more clearly and concisely. Keep the same meaning.',
        )

        expect(ipc.markdown_render_html).toHaveBeenCalledWith('Rewritten paragraph')

        expect(model_emitted_last(wrapper)).toEqual([
            'Rewritten paragraph\n\n- item one\n- item two',
        ])
    })

    it('sends the whole document flagged as such when nothing is selected', async () => {
        const rewrite = rewrite_handler('All new text')
        const wrapper = await mount_editor(MARKDOWN, rewrite)

        await ai_button(wrapper).trigger('click')

        expect(ai_meta(wrapper)).toBe('Whole document')

        await wrapper.get('.rich-editor-ai-input').setValue('Make it formal')
        await wrapper.get('.rich-editor-ai-custom .btn-primary').trigger('click')
        await flushPromises()

        const request = rewrite.mock.calls[0]?.[0]

        expect(request?.text).toBe(MARKDOWN)
        expect(request?.whole_document).toBe(true)
        expect(request?.instruction).toBe('Make it formal')
        expect(model_emitted_last(wrapper)).toEqual(['All new text'])
    })
})

describe('RichEditor AI rewrite', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    it('serialises a selection inside a bullet list as dash lines', async () => {
        const rewrite = rewrite_handler('- merged item')
        const wrapper = await mount_editor(MARKDOWN, rewrite)
        const editor = editor_from(wrapper)
        const { from, to } = text_range(editor, 'item one', 'item two')

        select(editor, from, to)

        expect(editor.state.doc.textBetween(from, to, '\n')).toBe('item one\nitem two')

        await ai_button(wrapper).trigger('click')
        await quick_action(wrapper, 'Shorten').trigger('click')
        await flushPromises()

        expect(rewrite.mock.calls[0]?.[0]?.text).toBe('- item one\n- item two')
        expect(rewrite.mock.calls[0]?.[0]?.whole_document).toBe(false)
    })

    it('refuses an empty custom instruction', async () => {
        const rewrite = rewrite_handler('x')
        const wrapper = await mount_editor(MARKDOWN, rewrite)

        await ai_button(wrapper).trigger('click')
        await wrapper.get('.rich-editor-ai-input').setValue('   ')
        await wrapper.get('.rich-editor-ai-input').trigger('keydown', { key: 'Enter' })
        await flushPromises()

        expect(rewrite).not.toHaveBeenCalled()
        expect(wrapper.get('.rich-editor-ai-error').text()).toBe('Enter an instruction.')
    })

    it('falls back to the whole document when the content is replaced', async () => {
        const rewrite = rewrite_handler('x')
        const wrapper = await mount_editor(MARKDOWN, rewrite)
        const editor = editor_from(wrapper)
        const { from, to } = text_range(editor, 'item two', 'item two')

        select(editor, from, to)
        await ai_button(wrapper).trigger('click')

        expect(ai_meta(wrapper)).toBe('8 characters selected')

        editor.commands.setContent('Tiny', { [EMIT_UPDATE]: false })
        await flushPromises()

        expect(ai_meta(wrapper)).toBe('Whole document')

        await quick_action(wrapper, 'Expand').trigger('click')
        await flushPromises()

        expect(rewrite.mock.calls[0]?.[0]?.text).toBe('Tiny')
        expect(rewrite.mock.calls[0]?.[0]?.whole_document).toBe(true)
    })
})

describe('RichEditor AI rewrite', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    it(TITLE_PRESS_OUTSIDE, async () => {
        const wrapper = await mount_editor(MARKDOWN, rewrite_handler('x'))
        const editor = editor_from(wrapper)

        select(editor, 1, 16)
        await ai_button(wrapper).trigger('click')
        await wrapper.get('.rich-editor-ai-input').trigger('mousedown')

        expect(ai_meta(wrapper)).toBe('15 characters selected')

        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        await flushPromises()

        expect(editor.state.selection.empty).toBe(true)
        expect(ai_meta(wrapper)).toBe('Whole document')
    })

    it('shows the handler error message and stays open', async () => {
        const rewrite = vi.fn(async () => Promise.reject(new Error('network error: offline')))
        const wrapper = await mount_editor(MARKDOWN, rewrite)

        await ai_button(wrapper).trigger('click')
        await quick_action(wrapper, 'Fix grammar').trigger('click')
        await flushPromises()

        expect(wrapper.get('.rich-editor-ai-error').text()).toBe('network error: offline')
        expect(wrapper.find('.rich-editor-ai').exists()).toBe(true)
    })

    it('reports an empty reply', async () => {
        const rewrite = vi.fn(async () => Promise.resolve(''))
        const wrapper = await mount_editor(MARKDOWN, rewrite)

        await ai_button(wrapper).trigger('click')
        await quick_action(wrapper, 'Expand').trigger('click')
        await flushPromises()

        expect(wrapper.get('.rich-editor-ai-error').text()).toBe('The AI did not return any text.')
    })

    it('strips a code fence from the reply', async () => {
        const rewrite = rewrite_handler('```markdown\nFenced reply\n```')
        const wrapper = await mount_editor(MARKDOWN, rewrite)

        await ai_button(wrapper).trigger('click')
        await quick_action(wrapper, 'Rewrite').trigger('click')
        await flushPromises()

        expect(ipc.markdown_render_html).toHaveBeenCalledWith('Fenced reply')
        expect(model_emitted_last(wrapper)).toEqual(['Fenced reply'])
    })
})

describe('RichEditor AI rewrite', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    it('closes the panel and forgets the range from the close button', async () => {
        const wrapper = await mount_editor(MARKDOWN, rewrite_handler('x'))
        const editor = editor_from(wrapper)

        select(editor, 1, 6)
        await ai_button(wrapper).trigger('click')
        await wrapper.get('[aria-label="Close AI panel"]').trigger('click')

        expect(wrapper.find('.rich-editor-ai').exists()).toBe(false)

        collapse(editor, 1)
        await ai_button(wrapper).trigger('click')

        expect(ai_meta(wrapper)).toBe('Whole document')
    })

    it('hides the AI button without a handler', async () => {
        const wrapper = await mount_editor()

        expect(wrapper.find('.rich-tb-btn-ai').exists()).toBe(false)
    })
})
