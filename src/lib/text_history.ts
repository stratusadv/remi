import { assert } from './assert'


const INPUT_TYPE_LENGTH_MAX = 64
const KEY_LENGTH_MAX = 32
const TEXT_HISTORY_GAP_MS = 1_000
const TEXT_HISTORY_STEPS_MAX = 100

export const TEXT_HISTORY_COMMANDS: readonly TextHistoryCommand[] = Object.freeze(['redo', 'undo'])
export const TEXT_HISTORY_LENGTH_MAX = 65_536


export type TextEditKind = 'delete' | 'insert' | 'other'
export type TextHistoryCommand = 'redo' | 'undo'

export interface TextEdit {
    readonly at: number
    readonly kind: TextEditKind
}

export interface TextHistory {
    readonly at: number
    readonly kind: TextEditKind | null
    readonly last: TextSnapshot
    readonly redo: readonly TextSnapshot[]
    readonly undo: readonly TextSnapshot[]
}

export interface TextHistoryKeys {
    readonly alt: boolean
    readonly ctrl: boolean
    readonly key: string
    readonly shift: boolean
}

export interface TextSnapshot {
    readonly end: number
    readonly start: number
    readonly text: string
}

export interface TextStep {
    readonly history: TextHistory
    readonly shown: TextSnapshot
}

export function text_edit_kind_of(input_type: string): TextEditKind {
    assert(input_type.length <= INPUT_TYPE_LENGTH_MAX)
    assert(!input_type.startsWith('history'))

    if (input_type === 'insertText') return 'insert'
    if (input_type === 'insertCompositionText') return 'insert'
    if (input_type === 'deleteContentBackward') return 'delete'
    if (input_type === 'deleteContentForward') return 'delete'

    return 'other'
}

export function text_history_command_of_input(input_type: string): TextHistoryCommand | null {
    assert(input_type.length <= INPUT_TYPE_LENGTH_MAX)
    assert(input_type === input_type.trim())

    if (input_type === 'historyUndo') return 'undo'
    if (input_type === 'historyRedo') return 'redo'

    return null
}

export function text_history_command_of_keys(keys: TextHistoryKeys): TextHistoryCommand | null {
    assert(keys.key.length > 0)
    assert(keys.key.length <= KEY_LENGTH_MAX)

    if (!keys.ctrl) return null
    if (keys.alt) return null

    const key = keys.key.toLowerCase()

    if (key === 'y') return keys.shift ? null : 'redo'
    if (key !== 'z') return null

    return keys.shift ? 'redo' : 'undo'
}

export function text_history_of(snapshot: TextSnapshot): TextHistory {
    assert(snapshot.text.length <= TEXT_HISTORY_LENGTH_MAX)
    assert(snapshot_fits(snapshot))

    return { at: 0, kind: null, last: snapshot, redo: [], undo: [] }
}

export function text_history_record(
    history: TextHistory,
    current: TextSnapshot,
    edit: TextEdit,
): TextHistory {
    assert(history.undo.length <= TEXT_HISTORY_STEPS_MAX)
    assert(snapshot_fits(current))
    assert(edit.at >= 0)

    const stale = current.text !== history.last.text
    const base = stale ? steps_push(history.undo, history.last) : history.undo
    const joined = !stale && edit_joins(history, current, edit)
    const undo = joined ? base : steps_push(base, current)

    assert(undo.length <= TEXT_HISTORY_STEPS_MAX)

    if (history.undo.length < TEXT_HISTORY_STEPS_MAX) assert(undo.length >= history.undo.length)

    return { at: edit.at, kind: edit.kind, last: current, redo: [], undo }
}

export function text_history_redo(history: TextHistory, current: TextSnapshot): TextStep | null {
    assert(history.redo.length <= TEXT_HISTORY_STEPS_MAX)
    assert(snapshot_fits(current))

    if (current.text !== history.last.text) return null

    const shown = history.redo.at(-1)

    if (shown === undefined) return null

    const redone: TextHistory = {
        at: history.at,
        kind: null,
        last: shown,
        redo: history.redo.slice(0, -1),
        undo: steps_push(history.undo, current),
    }

    assert(redone.redo.length < history.redo.length)

    return { history: redone, shown }
}

export function text_history_settle(history: TextHistory, current: TextSnapshot): TextHistory {
    assert(history.undo.length <= TEXT_HISTORY_STEPS_MAX)
    assert(snapshot_fits(current))

    return { ...history, last: current }
}

export function text_history_undo(history: TextHistory, current: TextSnapshot): TextStep | null {
    assert(history.undo.length <= TEXT_HISTORY_STEPS_MAX)
    assert(snapshot_fits(current))

    if (current.text !== history.last.text) {
        const reverted = { ...history, kind: null, redo: steps_push(history.redo, current) }

        return { history: reverted, shown: history.last }
    }

    const shown = history.undo.at(-1)

    if (shown === undefined) return null

    const undone: TextHistory = {
        at: history.at,
        kind: null,
        last: shown,
        redo: steps_push(history.redo, current),
        undo: history.undo.slice(0, -1),
    }

    assert(undone.undo.length < history.undo.length)

    return { history: undone, shown }
}

function edit_joins(history: TextHistory, current: TextSnapshot, edit: TextEdit): boolean {
    assert(history.last.text === current.text)
    assert(snapshot_fits(current))
    assert(edit.at >= 0)

    if (edit.kind === 'other') return false
    if (edit.kind !== history.kind) return false
    if (edit.at - history.at > TEXT_HISTORY_GAP_MS) return false
    if (current.start !== history.last.start) return false

    return current.end === history.last.end
}

function snapshot_fits(snapshot: TextSnapshot): boolean {
    assert(Number.isSafeInteger(snapshot.start))
    assert(Number.isSafeInteger(snapshot.end))

    if (snapshot.text.length > TEXT_HISTORY_LENGTH_MAX) return false
    if (snapshot.start < 0) return false
    if (snapshot.start > snapshot.end) return false

    return snapshot.end <= snapshot.text.length
}

function steps_push(
    steps: readonly TextSnapshot[],
    snapshot: TextSnapshot,
): readonly TextSnapshot[] {
    assert(steps.length <= TEXT_HISTORY_STEPS_MAX)
    assert(snapshot_fits(snapshot))

    if (steps.at(-1)?.text === snapshot.text) return steps

    const pushed = [...steps, snapshot]
    const kept = pushed.length > TEXT_HISTORY_STEPS_MAX ? pushed.slice(1) : pushed

    assert(kept.length <= TEXT_HISTORY_STEPS_MAX)

    return kept
}
