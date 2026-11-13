import { describe, expect, it } from 'vitest'
import { assert } from '../../src/lib/assert'
import {
    text_edit_kind_of,
    text_history_command_of_input,
    text_history_command_of_keys,
    text_history_of,
    text_history_record,
    text_history_redo,
    text_history_settle,
    text_history_undo,
} from '../../src/lib/text_history'
import type {
    TextEdit,
    TextEditKind,
    TextHistory,
    TextHistoryCommand,
    TextSnapshot,
} from '../../src/lib/text_history'


const COMMANDS: readonly TextHistoryCommand[] = Object.freeze(['redo', 'undo'])
const EDITS_COUNT = 60
const RANDOM_INCREMENT = 1_013_904_223
const RANDOM_MODULUS = 4_294_967_296
const RANDOM_MULTIPLIER = 1_664_525
const ROLLS_COUNT = EDITS_COUNT * 2
const SEEDS_COUNT = 40
const STEPS_MAX = 100
const TEXT_LENGTH_MAX = 1_000


interface Field {
    readonly history: TextHistory
    readonly shown: TextSnapshot
}

interface Walk {
    readonly field: Field
    readonly texts: readonly string[]
}

function caret(text: string): TextSnapshot {
    assert(text.length < TEXT_LENGTH_MAX)
    assert(!text.includes('\n'))

    return { end: text.length, start: text.length, text }
}

function field_changed(field: Field, text: string): Field {
    assert(text !== field.shown.text)
    assert(text.length < TEXT_LENGTH_MAX)

    return { ...field, shown: caret(text) }
}

function field_edit(field: Field, text: string, edit: TextEdit): Field {
    assert(text !== field.shown.text)
    assert(edit.at >= field.history.at)

    const recorded = text_history_record(field.history, field.shown, edit)
    const shown = caret(text)

    return { history: text_history_settle(recorded, shown), shown }
}

function field_of(text: string): Field {
    assert(text.length < TEXT_LENGTH_MAX)
    assert(!text.includes('\n'))

    return { history: text_history_of(caret(text)), shown: caret(text) }
}

function field_step(field: Field, command: TextHistoryCommand): Field | null {
    assert(field.shown.end <= field.shown.text.length)
    assert(COMMANDS.includes(command))

    const step = command === 'undo'
        ? text_history_undo(field.history, field.shown)
        : text_history_redo(field.history, field.shown)

    if (step === null) return null

    return { history: step.history, shown: step.shown }
}

function field_typed(field: Field, typed: string, at: number): Field {
    assert(typed.length > 0)
    assert(at >= field.history.at)

    let current = field

    for (let index = 0; index < typed.length; index += 1) {
        const edit = { at: at + index * 100, kind: 'insert' as const }

        current = field_edit(current, current.shown.text + typed.charAt(index), edit)
    }

    return current
}

function kind_rolled(roll: number): TextEditKind {
    assert(roll >= 0)
    assert(roll < 1)

    if (roll < 0.6) return 'insert'
    if (roll < 0.85) return 'delete'

    return 'other'
}

function rolls_of(seed: number): number[] {
    assert(Number.isSafeInteger(seed))
    assert(seed > 0)

    const rolls: number[] = []
    let state = seed

    for (let index = 0; index < ROLLS_COUNT; index += 1) {
        state = (Math.imul(state, RANDOM_MULTIPLIER) + RANDOM_INCREMENT) >>> 0
        rolls.push(state / RANDOM_MODULUS)
    }

    return rolls
}

function walked(field: Field, command: TextHistoryCommand): Walk {
    assert(field.history.undo.length <= STEPS_MAX)
    assert(COMMANDS.includes(command))

    const texts: string[] = []
    let current = field

    for (let count = 0; count <= STEPS_MAX + 1; count += 1) {
        const next = field_step(current, command)

        if (next === null) break

        current = next
        texts.push(current.shown.text)
    }

    assert(texts.length <= STEPS_MAX + 1)

    return { field: current, texts }
}

describe('text_history_record', () => {
    it('makes quick typing one step and starts another after a pause or a new kind of edit', () => {
        const quick = field_typed(field_of(''), 'hello', 1_000)

        expect(walked(quick, 'undo').texts).toEqual([''])

        const paused = field_typed(field_typed(field_of(''), 'hi', 1_000), ' you', 5_000)

        expect(walked(paused, 'undo').texts).toEqual(['hi', ''])

        const typed = field_typed(field_of(''), 'abc', 1_000)
        const deleted = field_edit(typed, 'ab', { at: 1_400, kind: 'delete' })
        const pasted = field_edit(deleted, 'ab pasted', { at: 1_500, kind: 'other' })

        expect(walked(pasted, 'undo').texts).toEqual(['ab', 'abc', ''])
    })

    it('starts a new step when the caret moves between edits', () => {
        const typed = field_typed(field_of(''), 'ab', 1_000)
        const moved = { ...typed, shown: { end: 0, start: 0, text: 'ab' } }
        const edited = field_edit(moved, 'xab', { at: 1_300, kind: 'insert' })

        expect(walked(edited, 'undo').texts).toEqual(['ab', ''])
    })

    it('keeps the newest hundred steps', () => {
        let field = field_of('')

        for (let index = 0; index < 150; index += 1) {
            field = field_edit(field, `${field.shown.text}x`, { at: index * 10_000, kind: 'other' })
        }

        const undone = walked(field, 'undo').texts

        expect(undone).toHaveLength(STEPS_MAX)
        expect(undone.at(-1)).toBe('x'.repeat(50))
    })
})

describe('text_history_undo', () => {
    it('undoes and redoes a change made around the history as one step', () => {
        const typed = field_typed(field_of(''), 'Fixed it', 1_000)
        const rewritten = field_changed(typed, 'Corrected the import parser')
        const undone = field_step(rewritten, 'undo')

        assert(undone !== null)

        const redone = field_step(undone, 'redo')

        assert(redone !== null)

        expect(undone.shown.text).toBe('Fixed it')
        expect(redone.shown.text).toBe('Corrected the import parser')

        const back = field_step(redone, 'undo')

        assert(back !== null)

        const exclaimed = field_typed(back, '!', 9_000)
        const again = field_changed(exclaimed, 'Rewritten again')
        const ended = field_edit(again, 'Rewritten again.', { at: 9_500, kind: 'insert' })
        const texts = walked(ended, 'undo').texts

        expect(texts).toEqual(['Rewritten again', 'Fixed it!', 'Fixed it', ''])
    })

    it('drops the redo steps after a new edit and refuses one after an outside change', () => {
        const typed = field_typed(field_typed(field_of(''), 'one', 1_000), ' two', 5_000)
        const undone = field_step(typed, 'undo')

        assert(undone !== null)

        const edited = field_edit(undone, 'one!', { at: 9_000, kind: 'insert' })

        expect(field_step(edited, 'redo')).toBe(null)

        const back = field_step(edited, 'undo')

        assert(back !== null)

        expect(back.shown.text).toBe('one')
        expect(field_step(field_changed(back, 'changed elsewhere'), 'redo')).toBe(null)
    })
})

describe('text_history_redo', () => {
    it('walks back through texts the field really held and redo walks forward again', () => {
        for (let seed = 1; seed <= SEEDS_COUNT; seed += 1) {
            const rolls = rolls_of(seed)
            const held = new Set<string>([''])
            let field = field_of('')
            let at = 0

            for (let count = 0; count < EDITS_COUNT; count += 1) {
                const kind = kind_rolled(rolls[count * 2] ?? 0)
                const text = field.shown.text

                const next = kind === 'delete'
                    ? text.slice(0, -1)
                    : `${text}${String(count % 10)}`

                at += (rolls[count * 2 + 1] ?? 0) < 0.8 ? 120 : 3_000

                if (next === text) continue

                field = field_edit(field, next, { at, kind })
                held.add(next)
            }

            const last = field.shown.text
            const undone = walked(field, 'undo')
            const redone = walked(undone.field, 'redo')
            const label = `seed ${String(seed)}`

            expect(undone.texts.at(-1), label).toBe('')

            for (const [index, text] of undone.texts.entries()) {
                expect(held.has(text), label).toBe(true)
                expect(text, label).not.toBe(index === 0 ? last : undone.texts[index - 1])
            }

            expect(redone.texts, label).toEqual([...undone.texts.slice(0, -1).reverse(), last])
        }
    })
})

describe('text_history_command_of', () => {
    it('joins only the four typing input types and reads only history types as commands', () => {
        expect(text_edit_kind_of('insertText')).toBe('insert')
        expect(text_edit_kind_of('insertCompositionText')).toBe('insert')
        expect(text_edit_kind_of('deleteContentBackward')).toBe('delete')
        expect(text_edit_kind_of('deleteContentForward')).toBe('delete')
        expect(text_edit_kind_of('insertFromPaste')).toBe('other')
        expect(text_edit_kind_of('deleteByCut')).toBe('other')
        expect(text_history_command_of_input('historyUndo')).toBe('undo')
        expect(text_history_command_of_input('historyRedo')).toBe('redo')
        expect(text_history_command_of_input('insertText')).toBe(null)
    })

    it('reads Ctrl+Z as undo, Ctrl+Shift+Z or Ctrl+Y as redo, and leaves other keys alone', () => {
        const keys = { alt: false, ctrl: true, key: 'z', shift: false }

        expect(text_history_command_of_keys(keys)).toBe('undo')
        expect(text_history_command_of_keys({ ...keys, key: 'Z', shift: true })).toBe('redo')
        expect(text_history_command_of_keys({ ...keys, key: 'y' })).toBe('redo')
        expect(text_history_command_of_keys({ ...keys, ctrl: false })).toBe(null)
        expect(text_history_command_of_keys({ ...keys, alt: true })).toBe(null)
        expect(text_history_command_of_keys({ ...keys, key: 'Y', shift: true })).toBe(null)
        expect(text_history_command_of_keys({ ...keys, key: 'x' })).toBe(null)
    })
})
