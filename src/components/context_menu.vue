<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { use_context_menu } from '../composables/use_context_menu'
import { assert } from '../lib/assert'
import MenuIcon from './menu_icon.vue'
import type { CSSProperties } from 'vue'
import type { MenuShown } from '../composables/use_context_menu'


const FOCUS_STEPS: Readonly<Record<string, number>> = Object.freeze({ ArrowDown: 1, ArrowUp: -1 })
const VIEWPORT_MARGIN_PX = 8
const { menu, choose, close } = use_context_menu()
const list_ref = ref<HTMLElement | null>(null)
const focus_before = ref<HTMLElement | null>(null)
const left_px = ref(0)
const top_px = ref(0)
const placed = ref(false)

const position = computed<CSSProperties>(() => ({
    left: `${String(left_px.value)}px`,
    top: `${String(top_px.value)}px`,
    right: 'auto',
    visibility: placed.value ? 'visible' : 'hidden',
}))


watch(menu, (shown, before) => {
    placed.value = false

    if (shown === null) {
        listeners_detach()

        return
    }

    if (before === null) {
        focus_before.value = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null

        listeners_attach()
    }

    void nextTick(place.bind(undefined, shown))
})

onBeforeUnmount(listeners_detach)

function close_on_outside(event: MouseEvent): void {
    assert(event.type === 'mousedown')

    if (!(event.target instanceof Node)) return
    if (list_ref.value?.contains(event.target) === true) return

    close()
}

function focus_first(shown: MenuShown): void {
    assert(shown.items.length > 0)
    assert(placed.value)

    if (menu.value !== shown) return

    list_ref.value?.querySelector('button')?.focus({ preventScroll: true })
}

function focus_move(step: number): void {
    assert(Math.abs(step) === 1)

    const buttons = [...(list_ref.value?.querySelectorAll('button') ?? [])]
    const index = buttons.findIndex((button) => button === document.activeElement)
    const next = index < 0 ? buttons.at(0) : buttons.at((index + step) % buttons.length)

    next?.focus()
}

function keydown(event: KeyboardEvent): void {
    assert(event.type === 'keydown')
    assert(menu.value === null || menu.value.items.length > 0)

    if (event.key === 'Escape') {
        event.preventDefault()
        close()
        focus_before.value?.focus()

        return
    }

    if (event.key === 'Tab') {
        close()

        return
    }

    const step = FOCUS_STEPS[event.key]

    if (step === undefined) return

    event.preventDefault()
    focus_move(step)
}

function listeners_attach(): void {
    document.addEventListener('mousedown', close_on_outside, true)
    document.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
}

function listeners_detach(): void {
    document.removeEventListener('mousedown', close_on_outside, true)
    document.removeEventListener('scroll', close, true)
    window.removeEventListener('blur', close)
    window.removeEventListener('resize', close)
}

function place(shown: MenuShown): void {
    assert(shown.items.length > 0)

    const list = list_ref.value

    if (list === null) return
    if (menu.value !== shown) return

    const rect = list.getBoundingClientRect()
    const left_max = window.innerWidth - VIEWPORT_MARGIN_PX - rect.width
    const top_max = window.innerHeight - VIEWPORT_MARGIN_PX - rect.height
    const top_above = Math.max(VIEWPORT_MARGIN_PX, shown.point.y_px - rect.height)

    left_px.value = Math.max(VIEWPORT_MARGIN_PX, Math.min(shown.point.x_px, left_max))
    top_px.value = shown.point.y_px > top_max ? top_above : shown.point.y_px
    placed.value = true

    void nextTick(focus_first.bind(undefined, shown))
}
</script>

<template>
    <Teleport to="body">
        <ul
            v-if="menu !== null"
            ref="list_ref"
            class="menu-popover menu-popover-fixed menu-popover-context"
            role="menu"
            :style="position"
            @keydown="keydown"
            @contextmenu.prevent
        >
            <li v-for="item in menu.items" :key="item.id" role="none">
                <button
                    type="button"
                    :class="['menu-item', item.danger ? 'menu-item-danger' : '']"
                    role="menuitem"
                    @click="choose(item.id)"
                >
                    <MenuIcon :name="item.icon" />
                    {{ item.label }}
                </button>
            </li>
        </ul>
    </Teleport>
</template>
