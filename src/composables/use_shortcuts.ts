import { onActivated, onDeactivated, onMounted, onUnmounted, shallowRef } from 'vue'
import { assert } from '../lib/assert'
import { use_modal_shown } from './use_modal'


type Handler = (event: KeyboardEvent) => void

interface ShortcutRegistration {
    shortcuts: Record<string, Handler>
}

const COMBO_SELECT_ALL = 'ctrl+a'

const INPUT_TYPES_NON_TEXT = Object.freeze([
    'button',
    'checkbox',
    'radio',
    'submit',
    'reset',
    'range',
    'color',
    'file',
])

const SHORTCUT_REGISTRATIONS_MAX = 6
const registrations_active = shallowRef<readonly ShortcutRegistration[]>(Object.freeze([]))


export function use_shortcuts(shortcuts: Record<string, Handler>): void {
    assert(typeof shortcuts === 'object')
    assert(Object.keys(shortcuts).length > 0)

    const registration: ShortcutRegistration = { shortcuts }

    onMounted(() => {
        registration_register(registration)
    })

    onActivated(() => {
        registration_register(registration)
    })

    onDeactivated(() => {
        registration_unregister(registration)
    })

    onUnmounted(() => {
        registration_unregister(registration)
    })
}

function combo_key_from(event: KeyboardEvent): string {
    assert(event.type.length > 0)
    assert(event.key.length > 0)

    const parts: string[] = []

    if (event_has_control(event)) parts.push('ctrl')
    if (event.shiftKey) parts.push('shift')
    if (event.altKey) parts.push('alt')

    const key_lower = event.key.toLowerCase()
    const key_name = key_lower === ' ' ? 'space' : key_lower

    parts.push(key_name)

    return parts.join('+')
}

function event_has_control(event: KeyboardEvent): boolean {
    assert(event.type.length > 0)
    assert(event instanceof KeyboardEvent)

    if (event.ctrlKey) return true

    return event.metaKey
}

function event_target_is_text_input(event: KeyboardEvent): boolean {
    assert(event.type.length > 0)
    assert(INPUT_TYPES_NON_TEXT.length > 0)

    const { target } = event

    if (!(target instanceof HTMLElement)) return false
    if (target.isContentEditable) return true
    if (target instanceof HTMLTextAreaElement) return true

    if (target instanceof HTMLInputElement) {
        return !INPUT_TYPES_NON_TEXT.includes(target.type.toLowerCase())
    }

    return false
}

window.addEventListener('keydown', listener_global_keydown)
window.addEventListener('keydown', listener_select_all)

function handler_topmost(combo: string): Handler | undefined {
    assert(combo.length > 0)
    assert(registrations_active.value.length <= SHORTCUT_REGISTRATIONS_MAX)

    const registrations = registrations_active.value

    for (let index = registrations.length - 1; index >= 0; index -= 1) {
        const registration = registrations[index]

        assert(registration !== undefined)

        if (Object.hasOwn(registration.shortcuts, combo)) return registration.shortcuts[combo]
    }

    return undefined
}

function listener_global_keydown(event: KeyboardEvent): void {
    assert(event.type.length > 0)
    assert(registrations_active.value.length <= SHORTCUT_REGISTRATIONS_MAX)

    if (use_modal_shown().value) return

    const combo = combo_key_from(event)
    const topmost = handler_topmost(combo)

    if (topmost === undefined) return

    if (!event_has_control(event)) {
        if (event_target_is_text_input(event)) return
    }

    event.preventDefault()
    topmost(event)
}

function listener_select_all(event: KeyboardEvent): void {
    assert(event.type === 'keydown')
    assert(COMBO_SELECT_ALL.startsWith('ctrl+'))

    if (combo_key_from(event) !== COMBO_SELECT_ALL) return
    if (event_target_is_text_input(event)) return

    event.preventDefault()
}

function registration_register(registration: ShortcutRegistration): void {
    assert(typeof registration.shortcuts === 'object')
    assert(registrations_active.value.length <= SHORTCUT_REGISTRATIONS_MAX)

    if (registrations_active.value.includes(registration)) return

    registrations_active.value = Object.freeze([...registrations_active.value, registration])

    assert(registrations_active.value.length <= SHORTCUT_REGISTRATIONS_MAX)
}

function registration_unregister(registration: ShortcutRegistration): void {
    assert(typeof registration.shortcuts === 'object')
    assert(registrations_active.value.length <= SHORTCUT_REGISTRATIONS_MAX)

    if (!registrations_active.value.includes(registration)) return

    const kept = registrations_active.value.filter((candidate) => candidate !== registration)

    registrations_active.value = Object.freeze(kept)

    assert(!registrations_active.value.includes(registration))
}
