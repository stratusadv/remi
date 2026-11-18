<script setup lang="ts">
import {
    computed,
    onBeforeUnmount,
    onMounted,
    ref,
    shallowRef,
    toValue,
    useId,
    useTemplateRef,
    watch,
} from 'vue'
import { Extension, createNodeFromContent, generateJSON } from '@tiptap/core'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { Markdown } from 'tiptap-markdown'
import { use_dialog } from '../composables/use_dialog'
import { assert } from '../lib/assert'
import { clipboard_plain_text } from '../lib/clipboard_text'
import { error_shown } from '../lib/errors'
import { ipc } from '../lib/ipc'
import { log_warn } from '../lib/log'
import type { AnyExtension, ChainedCommands, Content, Editor, JSONContent } from '@tiptap/core'
import type { AIGenerateHandler, AIRewriteHandler, AIRewriteRequest } from '../types'


type HeadingLevel = 1 | 2 | 3

interface AIQuickAction {
    id: string
    label: string
    instruction: string
}

interface AIRange {
    from: number
    to: number
}

const properties = defineProps<{
    placeholder?: string
    ai_rewrite?: AIRewriteHandler
    ai_generate?: AIGenerateHandler
}>()

const model = defineModel<string>({ required: true })

defineSlots<{ status?: () => unknown }>()

const HEADING_LEVELS = Object.freeze<HeadingLevel[]>([1, 2, 3])
const CODE_FENCE = '```'
const TOOLBAR_COLLAPSE_WIDTH_PX = 640
const SELECTION_GUARD_WINDOW_MS = 250
const MESSAGE_INSTRUCTION_MISSING = 'Enter an instruction.'
const MESSAGE_EMPTY_DOCUMENT = 'There is nothing to rewrite yet.'
const MESSAGE_EMPTY_REPLY = 'The AI did not return any text.'
const MESSAGE_EMPTY_LAYOUT = 'The AI did not return anything.'
const MESSAGE_DESCRIBE_FIRST = 'Describe the document first.'
const HTML_BLOCK_TAGS = 'p|h[1-6]|ul|ol|li|blockquote|pre|table|hr|div|span|strong|em|code|br'
const HTML_BLOCK_START = new RegExp(`^<(?:${HTML_BLOCK_TAGS})\\b`, 'iu')
const KEY_ADD_PROSE_MIRROR_PLUGINS = 'addProseMirrorPlugins'
const KEY_CLIPBOARD_TEXT_SERIALIZER = 'clipboardTextSerializer'
const KEY_COLUMNS = 'cols'
const KEY_EDITOR_PROPERTIES = 'editorProps'
const KEY_EMIT_UPDATE = 'emitUpdate'
const KEY_FILTER_TRANSACTION = 'filterTransaction'
const KEY_ON_SELECTION_UPDATE = 'onSelectionUpdate'
const KEY_ON_UPDATE = 'onUpdate'
const KEY_OPEN_ON_CLICK = 'openOnClick'
const KEY_PROPERTIES = 'props'
const KEY_TRANSFORM_PASTED_TEXT = 'transformPastedText'
const KEY_WITH_HEADER_ROW = 'withHeaderRow'

const PLACEHOLDER_LAYOUT = 'Describe the document, e.g. weekly team meeting: decisions, who does '
    + 'what by when, problems to watch'

const AI_QUICK_ACTIONS = Object.freeze<AIQuickAction[]>([
    {
        id: 'rewrite',
        label: 'Rewrite',
        instruction: 'Rewrite this more clearly and concisely. Keep the same meaning.',
    },
    {
        id: 'shorten',
        label: 'Shorten',
        instruction: 'Make this shorter without losing the key points.',
    },
    {
        id: 'expand',
        label: 'Expand',
        instruction: 'Expand this with more detail and context.',
    },
    {
        id: 'grammar',
        label: 'Fix grammar',
        instruction: 'Fix grammar, spelling, and punctuation. Do not change the meaning.',
    },
    {
        id: 'formal',
        label: 'More formal',
        instruction: 'Rewrite in a more formal, professional tone.',
    },
    {
        id: 'bullets',
        label: 'To bullets',
        instruction: 'Rewrite as a markdown bullet list. One bullet per distinct point.',
    },
])

const selection_guard = Extension.create({
    name: 'selection_guard',

    [KEY_ADD_PROSE_MIRROR_PLUGINS]() {
        assert(this.name === 'selection_guard')

        let armed_until = 0

        return [
            new Plugin({
                key: new PluginKey('selection_guard'),
                [KEY_FILTER_TRANSACTION](transaction, state) {
                    assert(transaction.selection.to <= transaction.doc.content.size)
                    assert(state.selection.to <= state.doc.content.size)
                    assert(armed_until >= 0)

                    if (transaction.docChanged) {
                        if (!transaction.selection.empty) {
                            armed_until = performance.now() + SELECTION_GUARD_WINDOW_MS
                        }

                        return true
                    }

                    if (performance.now() > armed_until) return true
                    if (!transaction.selectionSet) return true
                    if (state.selection.empty) return true
                    if (!transaction.selection.empty) return true
                    if (transaction.scrolledIntoView) return true

                    const pointer = Boolean(transaction.getMeta('pointer'))

                    return pointer || Boolean(transaction.getMeta('uiEvent'))
                },
            }),
        ]
    },
})

const selection_inactive = Extension.create({
    name: 'selection_inactive',

    [KEY_ADD_PROSE_MIRROR_PLUGINS]() {
        assert(this.name === 'selection_inactive')

        const { editor } = this

        return [
            new Plugin({
                key: new PluginKey('selection_inactive'),
                [KEY_PROPERTIES]: {
                    decorations(state) {
                        assert(state.selection.to <= state.doc.content.size)

                        const { from, to } = state.selection

                        if (from === to) return null
                        if (editor.isFocused) return null

                        assert(from < to)

                        return DecorationSet.create(
                            state.doc,
                            [Decoration.inline(from, to, { class: 'selection-inactive' })],
                        )
                    },
                },
            }),
        ]
    },
})

const { confirm: dialog_confirm, prompt: dialog_prompt } = use_dialog()
const fullscreen = ref(false)
const source_mode = ref(false)
const source_buffer = ref('')
const ai_panel_open = ref(false)
const ai_busy = ref(false)
const ai_instruction = ref('')
const ai_selected_preview = ref('')
const ai_range = ref<AIRange | null>(null)
const ai_error = ref('')
const has_selection = ref(false)
const is_in_table = ref(false)
const table_bar_dismissed = ref(false)
const toolbar_collapsed = ref(false)
const more_open = ref(false)
const more_panel_id = useId()
const root_element = useTemplateRef<HTMLElement>('root_element')
const resize_observer = shallowRef<ResizeObserver | null>(null)
const heading_level_active = ref<string>('')
const markdown_emitted = shallowRef(toValue(model))

async function ai_apply(instruction: string): Promise<void> {
    assert(instruction === ai_instruction.value
        || AI_QUICK_ACTIONS.some((action) => action.instruction === instruction))

    assert(ai_panel_open.value)
    assert(!source_mode.value)

    const editor_current = editor.value
    const rewrite = properties.ai_rewrite

    if (editor_current === undefined) return
    if (rewrite === undefined) return
    if (ai_busy.value) return

    const instruction_trimmed = instruction.trim()

    if (instruction_trimmed.length === 0) {
        ai_error.value = MESSAGE_INSTRUCTION_MISSING

        return
    }

    const range = ai_range.value
    const whole_document = range === null

    const text_original = range === null
        ? markdown_of(editor_current)
        : markdown_of_range(editor_current, range)

    if (text_original.trim().length === 0) {
        ai_error.value = MESSAGE_EMPTY_DOCUMENT

        return
    }

    ai_busy.value = true
    ai_error.value = ''

    const reply = ai_rewrite_request(
        { text: text_original, instruction: instruction_trimmed, whole_document },
        rewrite,
    )

    return reply
        .then(async (output_final) => ai_reply_insert(output_final, range))
        .catch((error: unknown) => {
            ai_error.value = error_shown(error)
        })
        .finally(() => {
            ai_busy.value = false
        })
}

function ai_close(): void {
    assert(ai_panel_open.value)
    assert(!source_mode.value)

    if (ai_busy.value) return

    ai_panel_open.value = false
    ai_instruction.value = ''
    ai_error.value = ''
    ai_selected_preview.value = ''
    ai_range.value = null
}

async function ai_content_build(raw: string): Promise<Content> {
    assert(raw.length > 0)
    assert(raw === raw.trim())

    if (looks_like_html(raw)) return ai_content_parse(raw)

    return ipc.markdown_render_html(raw)
        .catch((error: unknown) => {
            log_warn('[editor] markdown render failed, inserting raw text', error)

            return raw
        })
        .then((html) => ai_content_parse(html.trim().length === 0 ? raw : html))
}

function ai_content_parse(html: string): Content {
    assert(html.trim().length > 0)
    assert(ai_busy.value)

    try {
        return generateJSON(html, [...extensions]) as JSONContent
    } catch (error) {
        log_warn('[editor] reply could not be parsed as a document', error)

        return html
    }
}

function ai_custom_apply(): void {
    assert(ai_panel_open.value)
    assert(!source_mode.value)

    if (ai_busy.value) return

    if (properties.ai_generate !== undefined) {
        void ai_generate_apply()

        return
    }

    void ai_apply(ai_instruction.value)
}

async function ai_generate_apply(): Promise<void> {
    assert(ai_panel_open.value)
    assert(!source_mode.value)

    const editor_current = editor.value
    const generate = properties.ai_generate

    if (editor_current === undefined) return
    if (generate === undefined) return
    if (ai_busy.value) return

    const description = ai_instruction.value.trim()

    if (description.length === 0) {
        ai_error.value = MESSAGE_DESCRIBE_FIRST

        return
    }

    return ai_generate_confirm().then(async (confirmed) => {
        if (confirmed) await ai_generate_run(editor_current, description, generate)
    })
}

async function ai_generate_confirm(): Promise<boolean> {
    assert(properties.ai_generate !== undefined)
    assert(!ai_busy.value)

    if (model.value.trim().length === 0) return true

    return dialog_confirm(
        'Replace what is in the editor with a layout written by the AI?',
        { title: 'Replace layout', kind: 'warning' },
    )
}

const extensions = Object.freeze<AnyExtension[]>([
    StarterKit.configure({ link: false }),
    Link.configure({ [KEY_OPEN_ON_CLICK]: false, autolink: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: properties.placeholder ?? 'Start writing…' }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Markdown.configure({ html: true, [KEY_TRANSFORM_PASTED_TEXT]: true, breaks: true }),
    selection_guard,
    selection_inactive,
])

const editor = useEditor({
    content: toValue(model),
    extensions: [...extensions],
    [KEY_EDITOR_PROPERTIES]: {
        [KEY_CLIPBOARD_TEXT_SERIALIZER]: clipboard_text_serialize,
    },
    [KEY_ON_UPDATE]({ editor: editor_current, transaction }) {
        assert(transaction.getMeta('preventUpdate') !== true)
        assert(editor.value === undefined || editor.value === editor_current)

        const markdown = markdown_of(editor_current)

        markdown_emitted.value = markdown

        if (markdown !== model.value) model.value = markdown

        refresh_state(editor_current)
    },
    [KEY_ON_SELECTION_UPDATE]({ editor: editor_current }) {
        assert(editor.value === undefined || editor.value === editor_current)

        refresh_state(editor_current)
    },
})

const stats = computed(() => {
    const text = model.value
    const trimmed = text.trim()
    const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length

    return { chars: text.length, words }
})

const ai_button_title = computed(() => {
    if (properties.ai_generate !== undefined) return 'Write the layout with AI'
    if (has_selection.value) return 'Rewrite the selected text with AI'

    return 'Rewrite the whole document with AI'
})

const ai_input_placeholder = computed(() => properties.ai_generate === undefined
    ? 'Custom instruction (e.g. \'rewrite as bullet points\')'
    : PLACEHOLDER_LAYOUT)

const ai_submit_label = computed(() => {
    if (ai_busy.value) return 'Working…'

    return properties.ai_generate === undefined ? 'Apply' : 'Generate'
})

const ai_selected_count_text = computed(() => {
    const count = ai_selected_preview.value.length

    if (count === 0) return 'Whole document'

    return `${String(count)} character${count === 1 ? '' : 's'} selected`
})

watch(
    () => model.value,
    (next) => {
        if (source_mode.value) {
            source_buffer.value = next

            return
        }

        if (next === markdown_emitted.value) return

        content_apply()
    },
)

onMounted(() => {
    document.addEventListener('mousedown', selection_clear_on_outside, true)

    const root = root_element.value

    if (root === null) return

    resize_observer.value = new ResizeObserver((entries) => {
        const entry = entries[0]

        if (entry === undefined) return
        if (!entry.target.isConnected) return

        toolbar_collapsed.value = entry.contentRect.width < TOOLBAR_COLLAPSE_WIDTH_PX

        if (!toolbar_collapsed.value) more_open.value = false
    })

    resize_observer.value.observe(root)
})

onBeforeUnmount(() => {
    document.removeEventListener('mousedown', selection_clear_on_outside, true)
    resize_observer.value?.disconnect()
    editor.value?.destroy()
})

async function ai_generate_run(
    editor_current: Editor,
    description: string,
    generate: AIGenerateHandler,
): Promise<void> {
    assert(editor_current === editor.value)
    assert(description.length > 0)
    assert(generate === properties.ai_generate)

    ai_busy.value = true
    ai_error.value = ''

    return ai_layout_request(editor_current, description, generate)
        .catch((error: unknown) => {
            ai_error.value = error_shown(error)
        })
        .finally(() => {
            ai_busy.value = false
        })
}

async function ai_layout_request(
    editor_current: Editor,
    description: string,
    generate: AIGenerateHandler,
): Promise<void> {
    assert(editor_current === editor.value)
    assert(description.length > 0)
    assert(generate === properties.ai_generate)
    assert(ai_busy.value)

    return generate(description).then((reply) => {
        const generated = sanitize_llm_output(reply)

        if (generated.length === 0) {
            ai_error.value = MESSAGE_EMPTY_LAYOUT

            return
        }

        editor_current.commands.setContent(generated)

        ai_panel_open.value = false
        ai_instruction.value = ''
    })
}

function ai_open(): void {
    assert(!ai_panel_open.value)
    assert(!source_mode.value)

    if (properties.ai_generate !== undefined) {
        ai_instruction.value = ''
        ai_error.value = ''
        ai_panel_open.value = true

        return
    }

    const editor_current = editor.value

    if (properties.ai_rewrite === undefined) return
    if (editor_current === undefined) return

    ai_instruction.value = ''
    ai_error.value = ''
    ai_panel_open.value = true

    ai_range_set(editor_current)
}

function ai_quick_apply(action: AIQuickAction): void {
    assert(AI_QUICK_ACTIONS.includes(action))
    assert(action.instruction.length > 0)

    void ai_apply(action.instruction)
}

function ai_range_set(editor_current: Editor): void {
    assert(editor_current === editor.value)
    assert(ai_panel_open.value)

    const { from, to } = editor_current.state.selection

    ai_range.value = from === to ? null : { from, to }
    ai_selected_preview.value = editor_current.state.doc.textBetween(from, to, '\n')
}

async function ai_reply_insert(output_final: string, range: AIRange | null): Promise<void> {
    assert(output_final === output_final.trim())
    assert(range === null || range.from < range.to)

    const editor_after = editor.value

    assert(editor_after !== undefined)

    if (output_final.length === 0) {
        ai_error.value = MESSAGE_EMPTY_REPLY

        return
    }

    return ai_content_build(output_final).then((content) => {
        if (range === null) {
            editor_after.commands.setContent(content, { [KEY_EMIT_UPDATE]: true })

            return
        }

        const slice = Slice.maxOpen(fragment_of(content, editor_after))
        const transaction = editor_after.state.tr.replaceRange(range.from, range.to, slice)
        const to_inserted = transaction.mapping.map(range.to)

        const selection_inserted = TextSelection.between(
            transaction.doc.resolve(range.from),
            transaction.doc.resolve(to_inserted),
        )

        transaction.setSelection(selection_inserted)
        editor_after.view.dispatch(transaction.scrollIntoView())
        editor_after.commands.focus()
    })
}

async function ai_rewrite_request(
    request: Omit<AIRewriteRequest, 'on_chunk'>,
    rewrite: AIRewriteHandler,
): Promise<string> {
    assert(request.text.trim().length > 0)
    assert(request.instruction.length > 0)
    assert(request.whole_document === (ai_range.value === null))
    assert(rewrite === properties.ai_rewrite)

    const chunks: string[] = []

    function chunk_push(chunk: string): void {
        chunks.push(chunk)
    }

    return rewrite({ ...request, on_chunk: chunk_push })
        .then((reply) => sanitize_llm_output(reply.length > 0 ? reply : chunks.join('')))
}

function ai_toggle(): void {
    assert(!source_mode.value)
    assert(properties.ai_rewrite !== undefined || properties.ai_generate !== undefined)

    if (ai_panel_open.value) {
        ai_close()

        return
    }

    ai_open()
}

function clipboard_text_serialize(slice: Slice): string {
    assert(slice.openStart >= 0)
    assert(slice.openEnd >= 0)

    return clipboard_plain_text(slice.content)
}

function command_chain(): ChainedCommands | undefined {
    assert(!source_mode.value)
    assert(editor.value?.isDestroyed !== true)

    return editor.value?.chain().focus()
}

function content_apply(): void {
    assert(!source_mode.value)
    assert(model.value !== markdown_emitted.value)

    const editor_current = editor.value
    const next = model.value

    if (editor_current === undefined) return

    editor_current.commands.setContent(next, { [KEY_EMIT_UPDATE]: false })
    markdown_emitted.value = next

    refresh_state(editor_current)
}

function fragment_of(content: Content, editor_current: Editor): Fragment {
    assert(content !== null)
    assert(editor_current === editor.value)

    const node = createNodeFromContent(content, editor_current.schema, { slice: true })

    if (node instanceof Fragment) return node

    return node.type.name === 'doc' ? node.content : Fragment.from(node)
}

function fullscreen_toggle(): void {
    assert(root_element.value !== null)
    assert(root_element.value.isConnected)

    fullscreen.value = !fullscreen.value
}

function heading_change(event: Event): void {
    assert(event.type === 'change')
    assert(!source_mode.value)

    if (!(event.target instanceof HTMLSelectElement)) return

    const { value } = event.target
    const chain = command_chain()

    if (chain === undefined) return

    if (value === '') {
        chain.setParagraph().run()

        return
    }

    const level = Number.parseInt(value, 10)

    if (heading_level_is(level)) chain.setHeading({ level }).run()
}

function heading_level_is(value: number): value is HeadingLevel {
    assert(Number.isInteger(value))

    return HEADING_LEVELS.some((level) => level === value)
}

function heading_level_of(editor_current: Editor): string {
    assert(editor_current.schema.nodes['heading'] !== undefined)

    const level = HEADING_LEVELS.find((candidate) =>
        editor_current.isActive('heading', { level: candidate }))

    return level === undefined ? '' : String(level)
}

function is_active(name: string, attributes?: Record<string, unknown>): boolean {
    assert(name.length > 0)
    assert(attributes === undefined || Object.keys(attributes).length > 0)

    const editor_current = editor.value

    if (editor_current === undefined) return false

    assert(name in editor_current.schema.nodes || name in editor_current.schema.marks)

    if (attributes === undefined) return editor_current.isActive(name)

    return editor_current.isActive(name, attributes)
}

async function link_apply(): Promise<void> {
    assert(!source_mode.value)
    assert(editor.value?.isDestroyed !== true)

    const editor_current = editor.value

    if (editor_current === undefined) return

    const link_attributes = editor_current.getAttributes('link') as Record<string, unknown>
    const href_previous = link_attributes['href']
    const previous = typeof href_previous === 'string' ? href_previous : 'https://'
    const { from, to } = editor_current.state.selection

    return dialog_prompt('Link URL', previous, { title: 'Add a link' }).then((url) => {
        if (url === null) return

        const chain = editor_current.chain().focus().setTextSelection({ from, to })

        if (url.trim().length === 0) {
            chain.extendMarkRange('link').unsetLink().run()

            return
        }

        chain.extendMarkRange('link').setLink({ href: url }).run()
    })
}

function looks_like_html(text: string): boolean {
    assert(text.trim().length > 0)
    assert(!HTML_BLOCK_START.global)

    return HTML_BLOCK_START.test(text.trimStart())
}

function markdown_of(editor_current: Editor): string {
    assert(editor_current.storage.markdown !== undefined)

    return editor_current.storage.markdown.getMarkdown()
}

function markdown_of_range(editor_current: Editor, range: AIRange): string {
    assert(range.from < range.to)
    assert(range.to <= editor_current.state.doc.content.size)
    assert(editor_current.storage.markdown !== undefined)

    const doc = editor_current.state.doc
    const partial = doc.copy(doc.slice(range.from, range.to, true).content)

    return editor_current.storage.markdown.serializer.serialize(partial).trim()
}

function refresh_state(editor_current: Editor): void {
    assert(editor_current.state.selection.to <= editor_current.state.doc.content.size)
    assert(editor.value === undefined || editor.value === editor_current)

    const { from, to } = editor_current.state.selection

    has_selection.value = to > from
    is_in_table.value = editor_current.isActive('table')
    more_open.value = false

    if (!is_in_table.value) table_bar_dismissed.value = false

    heading_level_active.value = heading_level_of(editor_current)

    if (ai_panel_open.value) ai_range_set(editor_current)
}

function sanitize_llm_output(text: string): string {
    assert(typeof text === 'string')

    const cleaned = text.trim()

    if (!cleaned.startsWith(CODE_FENCE)) return cleaned
    if (!cleaned.endsWith(CODE_FENCE)) return cleaned

    const unfenced = cleaned
        .replace(/^```[a-zA-Z0-9_-]*\n?/u, '')
        .replace(/\n?```$/u, '')
        .trim()

    assert(unfenced.length < cleaned.length)

    return unfenced
}

function selection_clear_on_outside(event: MouseEvent): void {
    assert(event.type === 'mousedown')
    assert(event.currentTarget === document)

    const editor_current = editor.value
    const root = root_element.value

    if (editor_current === undefined) return
    if (root === null) return

    if (event.target instanceof Node) {
        if (root.contains(event.target)) return
    }

    if (editor_current.state.selection.empty) return

    editor_current
        .chain()
        .setMeta('pointer', true)
        .setTextSelection(editor_current.state.selection.to)
        .run()
}

function source_enter(): void {
    assert(!source_mode.value)
    assert(editor.value !== undefined)

    source_buffer.value = model.value
    source_mode.value = true
}

function source_exit(): void {
    assert(source_mode.value)
    assert(editor.value?.isDestroyed !== true)

    const next = source_buffer.value
    const editor_current = editor.value

    source_mode.value = false
    model.value = next

    if (editor_current !== undefined) {
        editor_current.commands.setContent(next, { [KEY_EMIT_UPDATE]: false })
        refresh_state(editor_current)
    }

    markdown_emitted.value = next
}

function source_input(event: Event): void {
    assert(event.type === 'input')
    assert(source_mode.value)

    if (!(event.target instanceof HTMLTextAreaElement)) return

    source_buffer.value = event.target.value
    model.value = source_buffer.value
}

function table_insert(): void {
    assert(!source_mode.value)

    if (is_in_table.value) {
        table_bar_dismissed.value = false

        return
    }

    command_chain()?.insertTable({ rows: 3, [KEY_COLUMNS]: 3, [KEY_WITH_HEADER_ROW]: true }).run()
}

function toolbar_class(name: string): string[] {
    assert(name.length > 0)

    return ['rich-tb-btn', is_active(name) ? 'rich-tb-btn-active' : '']
}
</script>

<template>
    <div ref="root_element" class="rich-editor" :data-fullscreen="fullscreen ? 'true' : 'false'">
        <div class="rich-editor-toolbar">
            <div
                :id="more_panel_id"
                class="rich-tb-more-panel"
                :data-open="more_open ? 'true' : 'false'"
            />
            <select
                :value="heading_level_active"
                class="rich-tb-select"
                :disabled="source_mode"
                @change="heading_change"
            >
                <option value="">Normal text</option>
                <option value="1">Heading 1</option>
                <option value="2">Heading 2</option>
                <option value="3">Heading 3</option>
            </select>
            <span class="rich-tb-sep" />
            <button
                type="button"
                :class="toolbar_class('bold')"
                title="Bold (Ctrl+B)"
                :disabled="source_mode"
                @mousedown.prevent
                @click="command_chain()?.toggleBold().run()"
            >
                <strong>B</strong>
            </button>
            <button
                type="button"
                :class="toolbar_class('italic')"
                title="Italic (Ctrl+I)"
                :disabled="source_mode"
                @mousedown.prevent
                @click="command_chain()?.toggleItalic().run()"
            >
                <em>I</em>
            </button>
            <Teleport defer :to="`#${more_panel_id}`" :disabled="!toolbar_collapsed">
                <button
                    type="button"
                    :class="toolbar_class('strike')"
                    title="Strikethrough"
                    :disabled="source_mode"
                    @mousedown.prevent
                    @click="command_chain()?.toggleStrike().run()"
                >
                    <s>S</s>
                </button>
                <button
                    type="button"
                    :class="toolbar_class('code')"
                    title="Inline code"
                    :disabled="source_mode"
                    @mousedown.prevent
                    @click="command_chain()?.toggleCode().run()"
                >
                    <code>&lt;&gt;</code>
                </button>
            </Teleport>
            <span class="rich-tb-sep" />
            <Teleport defer :to="`#${more_panel_id}`" :disabled="!toolbar_collapsed">
                <button
                    type="button"
                    :class="toolbar_class('bulletList')"
                    title="Bullet list"
                    :disabled="source_mode"
                    @mousedown.prevent
                    @click="command_chain()?.toggleBulletList().run()"
                >
                    •&nbsp;List
                </button>
                <button
                    type="button"
                    :class="toolbar_class('orderedList')"
                    title="Numbered list"
                    :disabled="source_mode"
                    @mousedown.prevent
                    @click="command_chain()?.toggleOrderedList().run()"
                >
                    1.&nbsp;List
                </button>
                <button
                    type="button"
                    :class="toolbar_class('taskList')"
                    title="Checklist"
                    :disabled="source_mode"
                    @mousedown.prevent
                    @click="command_chain()?.toggleTaskList().run()"
                >
                    ☑&nbsp;List
                </button>
                <span class="rich-tb-sep" />
                <button
                    type="button"
                    :class="toolbar_class('blockquote')"
                    title="Quote"
                    :disabled="source_mode"
                    @mousedown.prevent
                    @click="command_chain()?.toggleBlockquote().run()"
                >
                    &ldquo;&nbsp;&rdquo;
                </button>
                <button
                    type="button"
                    :class="toolbar_class('codeBlock')"
                    title="Code block"
                    :disabled="source_mode"
                    @mousedown.prevent
                    @click="command_chain()?.toggleCodeBlock().run()"
                >
                    { }
                </button>
                <button
                    type="button"
                    class="rich-tb-btn"
                    title="Horizontal rule"
                    :disabled="source_mode"
                    @mousedown.prevent
                    @click="command_chain()?.setHorizontalRule().run()"
                >
                    ―
                </button>
                <span class="rich-tb-sep" />
                <button
                    type="button"
                    :class="toolbar_class('link')"
                    title="Link"
                    :disabled="source_mode"
                    @mousedown.prevent
                    @click="link_apply"
                >
                    Link
                </button>
                <button
                    type="button"
                    class="rich-tb-btn"
                    :title="is_in_table ? 'Show table tools' : 'Insert table'"
                    :disabled="source_mode"
                    @mousedown.prevent
                    @click="table_insert"
                >
                    Table
                </button>
            </Teleport>
            <button
                v-if="toolbar_collapsed"
                type="button"
                :class="more_open ? 'rich-tb-btn rich-tb-btn-active' : 'rich-tb-btn'"
                :aria-expanded="more_open"
                title="More tools"
                @mousedown.prevent
                @click="more_open = !more_open"
            >
                More ▾
            </button>
            <button
                v-if="ai_rewrite || ai_generate"
                type="button"
                class="rich-tb-btn rich-tb-btn-ai"
                :aria-expanded="ai_panel_open"
                :title="ai_button_title"
                :disabled="source_mode"
                @mousedown.prevent
                @click="ai_toggle"
            >
                ✨ AI
            </button>
            <span class="flex-1" />
            <Teleport defer :to="`#${more_panel_id}`" :disabled="!toolbar_collapsed">
                <button
                    v-if="source_mode"
                    type="button"
                    class="rich-tb-btn rich-tb-btn-active"
                    title="Back to rich editor"
                    @click="source_exit"
                >
                    Rich editor
                </button>
                <button
                    v-else
                    type="button"
                    class="rich-tb-btn"
                    title="Edit raw markdown"
                    @click="source_enter"
                >
                    Markdown
                </button>
            </Teleport>
            <button
                type="button"
                class="rich-tb-btn"
                :title="fullscreen ? 'Exit fullscreen' : 'Fullscreen'"
                @mousedown.prevent
                @click="fullscreen_toggle"
            >
                {{ fullscreen ? 'Exit' : 'Fullscreen' }}
            </button>
        </div>

        <div
            v-if="!source_mode && is_in_table && !table_bar_dismissed"
            class="rich-editor-context-bar"
        >
            <span class="rich-editor-context-label">Table</span>
            <button
                type="button"
                class="rich-tb-btn"
                title="Add row above"
                @mousedown.prevent
                @click="command_chain()?.addRowBefore().run()"
            >
                + Row above
            </button>
            <button
                type="button"
                class="rich-tb-btn"
                title="Add row below"
                @mousedown.prevent
                @click="command_chain()?.addRowAfter().run()"
            >
                + Row below
            </button>
            <button
                type="button"
                class="rich-tb-btn"
                title="Add column left"
                @mousedown.prevent
                @click="command_chain()?.addColumnBefore().run()"
            >
                + Column left
            </button>
            <button
                type="button"
                class="rich-tb-btn"
                title="Add column right"
                @mousedown.prevent
                @click="command_chain()?.addColumnAfter().run()"
            >
                + Column right
            </button>
            <span class="rich-tb-sep" />
            <button
                type="button"
                class="rich-tb-btn"
                title="Toggle header row"
                @mousedown.prevent
                @click="command_chain()?.toggleHeaderRow().run()"
            >
                Toggle header
            </button>
            <button
                type="button"
                class="rich-tb-btn"
                title="Merge cells"
                @mousedown.prevent
                @click="command_chain()?.mergeCells().run()"
            >
                Merge
            </button>
            <button
                type="button"
                class="rich-tb-btn"
                title="Split cell"
                @mousedown.prevent
                @click="command_chain()?.splitCell().run()"
            >
                Split
            </button>
            <span class="flex-1" />
            <button
                type="button"
                class="rich-tb-btn"
                title="Delete row"
                @mousedown.prevent
                @click="command_chain()?.deleteRow().run()"
            >
                Delete row
            </button>
            <button
                type="button"
                class="rich-tb-btn"
                title="Delete column"
                @mousedown.prevent
                @click="command_chain()?.deleteColumn().run()"
            >
                Delete column
            </button>
            <button
                type="button"
                class="rich-tb-btn rich-tb-btn-danger"
                title="Delete entire table"
                @mousedown.prevent
                @click="command_chain()?.deleteTable().run()"
            >
                Delete table
            </button>
            <span class="rich-tb-sep" />
            <button
                type="button"
                class="rich-tb-btn rich-tb-btn-icon"
                title="Hide the table tools until you leave the table"
                aria-label="Close table tools"
                @mousedown.prevent
                @click="table_bar_dismissed = true"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.75"
                    stroke-linecap="round"
                    aria-hidden="true"
                >
                    <path d="M6 6l12 12" />
                    <path d="M18 6L6 18" />
                </svg>
            </button>
        </div>

        <div v-if="!source_mode && ai_panel_open" class="rich-editor-ai">
            <div class="rich-editor-ai-header">
                <span class="rich-editor-ai-title">
                    {{ ai_generate ? 'AI layout' : 'AI rewrite' }}
                </span>
                <template v-if="!ai_generate">
                    <span class="rich-editor-ai-meta opacity-60">·</span>
                    <span class="rich-editor-ai-meta">{{ ai_selected_count_text }}</span>
                </template>
                <span class="flex-1" />
                <button
                    type="button"
                    class="rich-tb-btn rich-tb-btn-icon"
                    title="Close"
                    aria-label="Close AI panel"
                    :disabled="ai_busy"
                    @mousedown.prevent
                    @click="ai_close"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.75"
                        stroke-linecap="round"
                        aria-hidden="true"
                    >
                        <path d="M6 6l12 12" />
                        <path d="M18 6L6 18" />
                    </svg>
                </button>
            </div>
            <div v-if="!ai_generate" class="rich-editor-ai-actions">
                <button
                    v-for="action in AI_QUICK_ACTIONS"
                    :key="action.id"
                    type="button"
                    class="rich-tb-btn"
                    :disabled="ai_busy"
                    @mousedown.prevent
                    @click="ai_quick_apply(action)"
                >
                    {{ action.label }}
                </button>
            </div>
            <div class="rich-editor-ai-custom">
                <input
                    v-model="ai_instruction"
                    type="text"
                    class="input rich-editor-ai-input"
                    maxlength="500"
                    :placeholder="ai_input_placeholder"
                    :disabled="ai_busy"
                    @keydown.enter.prevent="ai_custom_apply"
                >
                <button
                    type="button"
                    class="btn-primary"
                    :disabled="ai_busy || ai_instruction.trim().length === 0"
                    @mousedown.prevent
                    @click="ai_custom_apply"
                >
                    {{ ai_submit_label }}
                </button>
            </div>
            <p v-if="ai_error" class="rich-editor-ai-error">{{ ai_error }}</p>
        </div>

        <textarea
            v-if="source_mode"
            class="rich-editor-source"
            spellcheck="false"
            :value="source_buffer"
            @input="source_input"
        />
        <div v-else class="rich-editor-body">
            <EditorContent
                v-if="editor"
                :editor="editor"
                class="rich-editor-content prose-render"
            />
        </div>

        <div class="rich-editor-stats">
            <span>{{ stats.words }} word{{ stats.words === 1 ? '' : 's' }}</span>
            <span class="opacity-60">·</span>
            <span>{{ stats.chars }} character{{ stats.chars === 1 ? '' : 's' }}</span>
            <slot name="status" />
        </div>
    </div>
</template>
