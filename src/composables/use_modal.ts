import { computed, getCurrentInstance, nextTick, onUnmounted, shallowRef, watch } from 'vue'
import { assert } from '../lib/assert'
import { use_context_menu } from './use_context_menu'
import type { ComputedRef } from 'vue'


export type ModalLayer = keyof typeof MODAL_LAYER_RANKS

interface Modal {
    readonly focus_return: HTMLElement | null
    readonly layer: ModalLayer
}

const MODALS_OPEN_MAX = 3
const MODAL_LAYER_RANKS = Object.freeze({ dialog: 0, host: 1 })
const modals_open = shallowRef<readonly Modal[]>(Object.freeze([]))
const modal_shown = computed(() => modals_open.value.length > 0)


export function use_modal(layer: ModalLayer, shown: () => boolean): ComputedRef<boolean> {
    assert(Object.hasOwn(MODAL_LAYER_RANKS, layer))
    assert(typeof shown === 'function')
    assert(getCurrentInstance() !== null)

    const modal = shallowRef<Modal | null>(null)

    watch(
        shown,
        (open) => {
            assert(open === shown())

            if (modal.value !== null) modal_remove(modal.value)

            modal.value = open ? modal_push(layer) : null
        },
        { immediate: true },
    )

    onUnmounted(() => {
        if (modal.value !== null) modal_remove(modal.value)

        modal.value = null
    })

    return computed(() => modal.value !== null && modal_covered(modal.value))
}

export function use_modal_shown(): ComputedRef<boolean> {
    assert(modals_open.value.length <= MODALS_OPEN_MAX)

    return modal_shown
}

function focus_lost(): boolean {
    const active = document.activeElement

    if (active === null) return true
    if (active === document.body) return true
    if (!active.isConnected) return true

    return active.closest('[inert]') !== null
}

function focus_restore(modal: Modal): void {
    assert(!modals_open.value.includes(modal))
    assert(modals_open.value.length <= MODALS_OPEN_MAX)

    if (modal.focus_return === null) return
    if (!focus_lost()) return

    modal.focus_return.focus()
}

function modal_covered(modal: Modal): boolean {
    assert(modals_open.value.includes(modal))
    assert(modals_open.value.length <= MODALS_OPEN_MAX)

    return modals_open.value.at(-1) !== modal
}

function modal_push(layer: ModalLayer): Modal {
    assert(Object.hasOwn(MODAL_LAYER_RANKS, layer))
    assert(modals_open.value.length < MODALS_OPEN_MAX, 'more modals are open than the app stacks')

    const active = document.activeElement
    const focus_return = active instanceof HTMLElement ? active : null
    const modal: Modal = Object.freeze({ focus_return, layer })
    const rank = MODAL_LAYER_RANKS[layer]
    const below = modals_open.value.filter((open) => MODAL_LAYER_RANKS[open.layer] <= rank)
    const above = modals_open.value.filter((open) => MODAL_LAYER_RANKS[open.layer] > rank)

    modals_open.value = Object.freeze([...below, modal, ...above])

    assert(modals_open.value.indexOf(modal) === below.length)
    assert(modals_open.value.length <= MODALS_OPEN_MAX)

    use_context_menu().close()

    return modal
}

function modal_remove(modal: Modal): void {
    assert(modals_open.value.includes(modal))
    assert(modals_open.value.length <= MODALS_OPEN_MAX)

    modals_open.value = Object.freeze(modals_open.value.filter((open) => open !== modal))

    void nextTick(focus_restore.bind(undefined, modal))
}
