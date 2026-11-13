import { assert } from '../lib/assert'
import {
    TEXT_HISTORY_COMMANDS,
    TEXT_HISTORY_LENGTH_MAX,
    text_edit_kind_of,
    text_history_command_of_input,
    text_history_command_of_keys,
    text_history_of,
    text_history_record,
    text_history_redo,
    text_history_settle,
    text_history_undo,
} from '../lib/text_history'
import type { TextHistory, TextHistoryCommand, TextSnapshot } from '../lib/text_history'


const EDITABLE_PLAIN = 'plaintext-only'
const EDITING_DEPTH_MAX = 32

const INPUT_TYPES_TEXT: readonly string[] = Object.freeze([
    'email',
    'password',
    'search',
    'tel',
    'text',
    'url',
])


type TextControl = HTMLInputElement | HTMLTextAreaElement

const histories = new WeakMap<HTMLElement, TextHistory>()

export function text_history_listen(): void {
    assert(typeof document !== 'undefined')
    assert(typeof window !== 'undefined')

    document.addEventListener('beforeinput', text_history_beforeinput)
    document.addEventListener('focusin', text_history_focusin)
    document.addEventListener('input', text_history_input)
    window.addEventListener('keydown', text_history_keydown)
}

export function text_history_mark(element: HTMLElement | null): void {
    assert(element === null || element.isConnected)

    const field = text_field_of(element)

    if (field === null) return

    assert(text_length_of(field) <= TEXT_HISTORY_LENGTH_MAX)

    histories.set(field, histories.get(field) ?? text_history_of(snapshot_of(field)))
}

function caret_offsets(field: HTMLElement, length: number): readonly [number, number] {
    assert(field.isContentEditable)
    assert(length >= 0)

    const selection = window.getSelection()

    if (selection === null) return [length, length]
    if (selection.rangeCount === 0) return [length, length]

    const range = selection.getRangeAt(0)

    if (!field.contains(range.startContainer)) return [length, length]
    if (!field.contains(range.endContainer)) return [length, length]

    const before = document.createRange()

    before.selectNodeContents(field)
    before.setEnd(range.startContainer, range.startOffset)

    const start = Math.min(before.toString().length, length)
    const end = Math.min(start + range.toString().length, length)

    return [start, end]
}

function caret_place(field: HTMLElement, snapshot: TextSnapshot): void {
    assert(field.isContentEditable)
    assert(snapshot.start <= snapshot.end)

    const selection = window.getSelection()
    const node = field.firstChild
    const range = document.createRange()

    if (selection === null) return

    if (node instanceof Text) {
        range.setStart(node, Math.min(snapshot.start, node.length))
        range.setEnd(node, Math.min(snapshot.end, node.length))
    } else {
        range.selectNodeContents(field)
        range.collapse(false)
    }

    selection.removeAllRanges()
    selection.addRange(range)
}

function editing_host_of(field: HTMLElement): HTMLElement {
    assert(field.isContentEditable)
    assert(field.isConnected)

    let host = field

    for (let depth = 0; depth < EDITING_DEPTH_MAX; depth += 1) {
        const parent = host.parentElement

        if (parent === null) break
        if (!parent.isContentEditable) break

        host = parent
    }

    assert(host.isContentEditable)

    return host
}

function snapshot_of(field: HTMLElement): TextSnapshot {
    assert(field.isConnected)
    assert(text_length_of(field) <= TEXT_HISTORY_LENGTH_MAX)

    if (text_control_of(field)) {
        const text = field.value

        return {
            end: field.selectionEnd ?? text.length,
            start: field.selectionStart ?? text.length,
            text,
        }
    }

    const text = field.textContent
    const [start, end] = caret_offsets(field, text.length)

    assert(start <= end)

    return { end, start, text }
}

function text_control_of(field: HTMLElement): field is TextControl {
    assert(field.isConnected)
    assert(field.tagName.length > 0)

    if (field instanceof HTMLTextAreaElement) return true

    return field instanceof HTMLInputElement
}

function text_field_of(target: EventTarget | null): HTMLElement | null {
    assert(target === null || typeof target.dispatchEvent === 'function')

    if (!(target instanceof HTMLElement)) return null
    if (!target.isConnected) return null

    const field = text_field_typed(target)

    if (field === null) return null
    if (text_length_of(field) > TEXT_HISTORY_LENGTH_MAX) return null

    return field
}

function text_field_typed(target: HTMLElement): HTMLElement | null {
    assert(target.isConnected)
    assert(target.tagName.length > 0)

    if (target instanceof HTMLTextAreaElement) return target.readOnly ? null : target

    if (target instanceof HTMLInputElement) {
        if (target.readOnly) return null

        return INPUT_TYPES_TEXT.includes(target.type) ? target : null
    }

    if (!target.isContentEditable) return null

    const host = editing_host_of(target)

    return host.contentEditable === EDITABLE_PLAIN ? host : null
}

function text_history_apply(event: Event, command: TextHistoryCommand): void {
    assert(event.target !== null)
    assert(TEXT_HISTORY_COMMANDS.includes(command))

    const field = text_field_of(event.target)

    if (field === null) return

    event.preventDefault()

    const history = histories.get(field) ?? text_history_of(snapshot_of(field))
    const current = snapshot_of(field)

    const step = command === 'undo'
        ? text_history_undo(history, current)
        : text_history_redo(history, current)

    if (step === null) {
        histories.set(field, history)

        return
    }

    histories.set(field, step.history)

    if (text_control_of(field)) {
        field.value = step.shown.text

        if (field.selectionStart !== null) field.setSelectionRange(step.shown.start, step.shown.end)
    } else {
        field.replaceChildren(step.shown.text)

        caret_place(field, step.shown)
    }

    field.dispatchEvent(new Event('input', { bubbles: true }))
}

function text_history_beforeinput(event: InputEvent): void {
    assert(event.type === 'beforeinput')
    assert(event.target !== null)

    if (event.defaultPrevented) return

    const command = text_history_command_of_input(event.inputType)

    if (command !== null) {
        if (event.cancelable) text_history_apply(event, command)

        return
    }

    const field = text_field_of(event.target)

    if (field === null) return

    const history = histories.get(field) ?? text_history_of(snapshot_of(field))
    const edit = { at: event.timeStamp, kind: text_edit_kind_of(event.inputType) }

    histories.set(field, text_history_record(history, snapshot_of(field), edit))
}

function text_history_focusin(event: FocusEvent): void {
    assert(event.type === 'focusin')
    assert(event.target !== null)

    if (event.target instanceof HTMLElement) text_history_mark(event.target)
}

function text_history_input(event: Event): void {
    assert(event.type === 'input')
    assert(event.target !== null)

    const field = text_field_of(event.target)

    if (field === null) return

    const history = histories.get(field)

    if (history === undefined) return

    histories.set(field, text_history_settle(history, snapshot_of(field)))
}

function text_history_keydown(event: KeyboardEvent): void {
    assert(event.type === 'keydown')
    assert(event.key.length > 0)

    if (event.defaultPrevented) return
    if (event.isComposing) return

    const keys = {
        alt: event.altKey,
        ctrl: event.ctrlKey || event.metaKey,
        key: event.key,
        shift: event.shiftKey,
    }

    const command = text_history_command_of_keys(keys)

    if (command === null) return

    text_history_apply(event, command)
}

function text_length_of(field: HTMLElement): number {
    assert(field.isConnected)
    assert(field.tagName.length > 0)

    if (text_control_of(field)) return field.value.length

    return field.textContent.length
}
