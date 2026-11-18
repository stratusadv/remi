<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import { use_modal_shown } from '../composables/use_modal'
import { assert } from '../lib/assert'
import MenuIcon from './menu_icon.vue'
import type { MenuItem } from '../lib/menu'


const properties = defineProps<{
    label: string
    items: readonly MenuItem[]
}>()

const emit = defineEmits<{
    select: [id: string]
}>()

const POPOVER_GAP_PX = 6

const modal_shown = use_modal_shown()
const open = ref(false)
const root_element = useTemplateRef<HTMLElement>('root_element')
const popover_element = useTemplateRef<HTMLElement>('popover_element')
const popover_top_px = ref(0)
const popover_right_px = ref(0)

const popover_style = computed(() => ({
    top: `${String(popover_top_px.value)}px`,
    right: `${String(popover_right_px.value)}px`,
}))


function close_on_escape(event: KeyboardEvent): void {
    assert(event.type === 'keydown')
    assert(event.currentTarget === document)
    assert(popover_element.value !== null)

    if (event.key === 'Escape') open.value = false
}

function close_on_outside(event: MouseEvent): void {
    assert(event.type === 'mousedown')
    assert(event.currentTarget === document)
    assert(popover_element.value !== null)

    if (!(event.target instanceof Node)) return

    const in_trigger = root_element.value?.contains(event.target) ?? false
    const in_popover = popover_element.value.contains(event.target)

    if (in_trigger) return
    if (in_popover) return

    open.value = false
}

function close_on_scroll(): void {
    assert(popover_element.value !== null)

    open.value = false
}

function listeners_attach(): void {
    assert(open.value)
    assert(popover_element.value === null)

    document.addEventListener('mousedown', close_on_outside, true)
    document.addEventListener('keydown', close_on_escape, true)
    document.addEventListener('scroll', close_on_scroll, true)
    window.addEventListener('resize', close_on_scroll)
}

function listeners_detach(): void {
    assert(root_element.value !== null)

    document.removeEventListener('mousedown', close_on_outside, true)
    document.removeEventListener('keydown', close_on_escape, true)
    document.removeEventListener('scroll', close_on_scroll, true)
    window.removeEventListener('resize', close_on_scroll)
}

function select(id: string): void {
    assert(properties.items.some((item) => item.id === id))
    assert(popover_element.value !== null)

    open.value = false
    emit('select', id)
}

function toggle(): void {
    assert(properties.items.length > 0)
    assert(open.value || popover_element.value === null)

    if (open.value) {
        open.value = false

        return
    }

    const rect = root_element.value?.getBoundingClientRect()

    if (rect === undefined) return

    popover_top_px.value = rect.bottom + POPOVER_GAP_PX
    popover_right_px.value = window.innerWidth - rect.right
    open.value = true
}

watch(open, (is_open) => {
    assert(is_open === (popover_element.value === null))

    if (is_open) {
        listeners_attach()

        return
    }

    listeners_detach()
})

watch(
    modal_shown,
    (shown) => {
        assert(shown === modal_shown.value)

        if (shown) open.value = false
    },
    { flush: 'sync' },
)

onBeforeUnmount(listeners_detach)
</script>

<template>
    <div ref="root_element" class="menu shrink-0">
        <button
            type="button"
            class="menu-icon-btn"
            aria-haspopup="menu"
            :aria-expanded="open"
            :aria-label="`Options for ${properties.label}`"
            title="Options"
            @click.stop="toggle"
        >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.75" />
                <circle cx="12" cy="12" r="1.75" />
                <circle cx="19" cy="12" r="1.75" />
            </svg>
        </button>
        <Teleport to="body">
            <ul
                v-if="open"
                ref="popover_element"
                class="menu-popover menu-popover-fixed"
                role="menu"
                :style="popover_style"
            >
                <li v-for="item in properties.items" :key="item.id">
                    <button
                        type="button"
                        class="menu-item"
                        :class="item.danger ? 'menu-item-danger' : ''"
                        role="menuitem"
                        @click.stop="select(item.id)"
                    >
                        <MenuIcon :name="item.icon" />
                        {{ item.label }}
                    </button>
                </li>
            </ul>
        </Teleport>
    </div>
</template>
