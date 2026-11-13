import { ref } from 'vue'
import { assert } from '../lib/assert'


export type DialogKind = 'info' | 'warning' | 'error'

export interface DialogConfirmOptions {
    title?: string
    kind?: DialogKind
    ok_label?: string
    cancel_label?: string
}

export interface DialogMessageOptions {
    title?: string
    kind?: DialogKind
    ok_label?: string
}

export interface DialogPromptOptions {
    title?: string
    ok_label?: string
}

interface DialogFields {
    id: string
    title: string
    message: string
    kind: DialogKind
    ok_label: string
    cancel_label: string | null
    danger: boolean
    input_shown: boolean
}

interface DialogState extends DialogFields {
    resolve: (value: boolean) => void
}

const CANCEL_LABEL_DEFAULT = 'Cancel'
const OK_LABEL_DEFAULT = 'OK'
const TITLE_DEFAULT = 'Remi'
const current = ref<DialogState | null>(null)
const input = ref('')
const api = Object.freeze({ current, input, confirm, message, prompt, close })


export function use_dialog(): typeof api {
    assert(Object.isFrozen(api))
    assert(current.value === null || current.value.id.length > 0)

    return api
}

function close(value: boolean): void {
    assert(typeof value === 'boolean')

    const state = current.value

    if (state === null) return

    assert(typeof state.resolve === 'function')

    current.value = null

    state.resolve(value)
}

async function confirm(text: string, options?: DialogConfirmOptions): Promise<boolean> {
    assert(typeof text === 'string')
    assert(options === undefined || typeof options === 'object')

    const kind = options?.kind ?? 'warning'

    return show({
        id: crypto.randomUUID(),
        title: options?.title ?? TITLE_DEFAULT,
        message: text,
        kind,
        ok_label: options?.ok_label ?? OK_LABEL_DEFAULT,
        cancel_label: options?.cancel_label ?? CANCEL_LABEL_DEFAULT,
        danger: kind === 'warning' || kind === 'error',
        input_shown: false,
    })
}

async function message(text: string, options?: DialogMessageOptions): Promise<void> {
    assert(typeof text === 'string')
    assert(options === undefined || typeof options === 'object')

    const shown = show({
        id: crypto.randomUUID(),
        title: options?.title ?? TITLE_DEFAULT,
        message: text,
        kind: options?.kind ?? 'info',
        ok_label: options?.ok_label ?? OK_LABEL_DEFAULT,
        cancel_label: null,
        danger: false,
        input_shown: false,
    })

    return shown.then(() => undefined)
}

async function prompt(
    text: string,
    initial: string,
    options?: DialogPromptOptions,
): Promise<string | null> {
    assert(typeof text === 'string')
    assert(typeof initial === 'string')
    assert(options === undefined || typeof options === 'object')

    input.value = initial

    const shown = show({
        id: crypto.randomUUID(),
        title: options?.title ?? TITLE_DEFAULT,
        message: text,
        kind: 'info',
        ok_label: options?.ok_label ?? OK_LABEL_DEFAULT,
        cancel_label: CANCEL_LABEL_DEFAULT,
        danger: false,
        input_shown: true,
    })

    return shown.then(prompt_answer)
}

function prompt_answer(confirmed: boolean): string | null {
    assert(typeof confirmed === 'boolean')
    assert(typeof input.value === 'string')

    return confirmed ? input.value : null
}

async function show(fields: DialogFields): Promise<boolean> {
    assert(fields.id.length > 0)
    assert(fields.ok_label.length > 0)

    const previous = current.value

    if (previous !== null) previous.resolve(false)

    return new Promise<boolean>((resolve) => {
        current.value = { ...fields, resolve }
    })
}
