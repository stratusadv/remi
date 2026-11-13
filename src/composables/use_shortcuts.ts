import { onActivated, onDeactivated, onMounted, onUnmounted } from 'vue'
import { assert } from '../lib/assert'


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

const handlers_by_combo = new Map<string, Handler[]>()
const registrations_active = new Set<ShortcutRegistration>()


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
    assert(event.key.length >= 0)

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

function listener_global_keydown(event: KeyboardEvent): void {
    assert(event.type.length > 0)
    assert(handlers_by_combo.size >= 0)

    const combo = combo_key_from(event)
    const handlers = handlers_by_combo.get(combo)

    if (handlers === undefined) return

    if (!event_has_control(event)) {
        if (event_target_is_text_input(event)) return
    }

    const topmost = handlers[handlers.length - 1]

    if (topmost === undefined) return

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
    assert(registrations_active.size >= 0)

    if (registrations_active.has(registration)) return

    registrations_active.add(registration)

    for (const [combo, handler] of Object.entries(registration.shortcuts)) {
        const existing = handlers_by_combo.get(combo) ?? []

        existing.push(handler)
        handlers_by_combo.set(combo, existing)
    }
}

function registration_unregister(registration: ShortcutRegistration): void {
    assert(typeof registration.shortcuts === 'object')
    assert(registrations_active.size >= 0)

    if (!registrations_active.delete(registration)) return

    for (const [combo, handler] of Object.entries(registration.shortcuts)) {
        const existing = handlers_by_combo.get(combo)

        if (existing === undefined) continue

        const index = existing.indexOf(handler)

        if (index >= 0) existing.splice(index, 1)
        if (existing.length === 0) void handlers_by_combo.delete(combo)
    }
}
