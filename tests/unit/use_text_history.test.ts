import { beforeAll, describe, expect, it } from 'vitest'
import { assert } from '../../src/lib/assert'
import { text_history_listen, text_history_mark } from '../../src/composables/use_text_history'


const EVENT_CTRL = 'ctrlKey'
const EVENT_INPUT_TYPE = 'inputType'
const EVENT_SHIFT = 'shiftKey'
const IDS_PATTERN = /^[a-z-]+$/u


interface Press {
    readonly id: string
    readonly key: string
    readonly shift: boolean
}

interface Typing {
    readonly id: string
    readonly text: string
}

function control_of(id: string): HTMLInputElement | HTMLTextAreaElement {
    assert(IDS_PATTERN.test(id))

    const element = document.getElementById(id)

    assert(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)

    return element
}

function element_of(id: string): HTMLElement {
    assert(IDS_PATTERN.test(id))

    const element = document.getElementById(id)

    assert(element instanceof HTMLElement)

    return element
}

function fields_show(markup: string): void {
    assert(markup.length > 0)
    assert(markup.startsWith('<'))

    document.body.innerHTML = markup
}

function pressed(press: Press): boolean {
    assert(press.key.length === 1)
    assert(IDS_PATTERN.test(press.id))

    const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: press.key,
        [EVENT_CTRL]: true,
        [EVENT_SHIFT]: press.shift,
    })

    element_of(press.id).dispatchEvent(event)

    return event.defaultPrevented
}

function typed(typing: Typing): void {
    assert(IDS_PATTERN.test(typing.id))
    assert(typing.text.length > 0)

    const control = control_of(typing.id)

    control.focus()

    for (let index = 0; index < typing.text.length; index += 1) {
        const data = typing.text.charAt(index)
        const init = { bubbles: true, cancelable: true, data, [EVENT_INPUT_TYPE]: 'insertText' }

        control.dispatchEvent(new InputEvent('beforeinput', init))
        control.value += data
        control.dispatchEvent(new InputEvent('input', init))
    }
}

function value_of(id: string): string {
    assert(IDS_PATTERN.test(id))

    const element = element_of(id)

    assert(element.isConnected)

    if (element instanceof HTMLInputElement) return element.value
    if (element instanceof HTMLTextAreaElement) return element.value

    return element.textContent
}

beforeAll(() => {
    text_history_listen()
})

describe('text_history_listen', () => {
    it('undoes typing with Ctrl+Z and redoes it with Ctrl+Shift+Z or Ctrl+Y', () => {
        fields_show('<input id="plain" type="text">')
        typed({ id: 'plain', text: 'hello' })

        expect(pressed({ id: 'plain', key: 'z', shift: false })).toBe(true)
        expect(value_of('plain')).toBe('')
        expect(pressed({ id: 'plain', key: 'Z', shift: true })).toBe(true)
        expect(value_of('plain')).toBe('hello')
        expect(pressed({ id: 'plain', key: 'z', shift: false })).toBe(true)
        expect(value_of('plain')).toBe('')
        expect(pressed({ id: 'plain', key: 'y', shift: false })).toBe(true)
        expect(value_of('plain')).toBe('hello')
    })

    it('keeps a history for each field, an email input included', () => {
        fields_show('<input id="email" type="email"><textarea id="note"></textarea>')
        typed({ id: 'email', text: 'a@b.c' })
        typed({ id: 'note', text: 'note' })

        expect(pressed({ id: 'note', key: 'z', shift: false })).toBe(true)
        expect(value_of('note')).toBe('')
        expect(value_of('email')).toBe('a@b.c')
        expect(pressed({ id: 'email', key: 'z', shift: false })).toBe(true)
        expect(value_of('email')).toBe('')
    })

    it('undoes a value the app set as one step and tells v-model about it', () => {
        fields_show('<textarea id="draft">Fixed it</textarea>')
        text_history_mark(element_of('draft'))

        const draft = control_of('draft')
        const changes: string[] = []

        draft.addEventListener('input', () => {
            changes.push(draft.value)
        })

        draft.value = 'Rewritten'

        expect(pressed({ id: 'draft', key: 'z', shift: false })).toBe(true)
        expect(value_of('draft')).toBe('Fixed it')
        expect(pressed({ id: 'draft', key: 'y', shift: false })).toBe(true)
        expect(value_of('draft')).toBe('Rewritten')
        expect(changes).toEqual(['Fixed it', 'Rewritten'])
    })

    it('leaves a rich editor, a read-only field, and a button to themselves', () => {
        fields_show([
            '<div id="rich" contenteditable="true"><b>bold</b> text</div>',
            '<input id="locked" type="text" readonly value="kept">',
            '<button id="press" type="button">Go</button>',
        ].join(''))

        const rich = element_of('rich').innerHTML

        expect(pressed({ id: 'rich', key: 'z', shift: false })).toBe(false)
        expect(element_of('rich').innerHTML).toBe(rich)
        expect(pressed({ id: 'locked', key: 'z', shift: false })).toBe(false)
        expect(value_of('locked')).toBe('kept')
        expect(pressed({ id: 'press', key: 'z', shift: false })).toBe(false)
    })
})
