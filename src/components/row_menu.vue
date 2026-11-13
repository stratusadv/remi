<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import MenuIcon from './menu_icon.vue'
import type { MenuItem } from '../lib/menu'


const props = defineProps<{
    label: string
    items: MenuItem[]
}>()

const emit = defineEmits<{
    select: [id: string]
}>()

const POPOVER_GAP_PX = 6

const open = ref(false)
const root_ref = ref<HTMLElement | null>(null)
const popover_ref = ref<HTMLElement | null>(null)
const popover_top_px = ref(0)
const popover_right_px = ref(0)

const popover_style = computed(() => ({
    top: `${String(popover_top_px.value)}px`,
    right: `${String(popover_right_px.value)}px`,
}))


function close_on_escape(event: KeyboardEvent): void {
    if (event.key === 'Escape') open.value = false
}

function close_on_outside(event: MouseEvent): void {
    if (!(event.target instanceof Node)) return

    const in_trigger = root_ref.value?.contains(event.target) ?? false
    const in_popover = popover_ref.value?.contains(event.target) ?? false

    if (!in_trigger && !in_popover) open.value = false
}

function close_on_scroll(): void {
    open.value = false
}

function listeners_attach(): void {
    document.addEventListener('mousedown', close_on_outside, true)
    document.addEventListener('keydown', close_on_escape, true)
    document.addEventListener('scroll', close_on_scroll, true)
    window.addEventListener('resize', close_on_scroll)
}

function listeners_detach(): void {
    document.removeEventListener('mousedown', close_on_outside, true)
    document.removeEventListener('keydown', close_on_escape, true)
    document.removeEventListener('scroll', close_on_scroll, true)
    window.removeEventListener('resize', close_on_scroll)
}

function select(id: string): void {
    open.value = false
    emit('select', id)
}

function toggle(): void {
    if (open.value) {
        open.value = false

        return
    }

    const rect = root_ref.value?.getBoundingClientRect()

    if (rect === undefined) return

    popover_top_px.value = rect.bottom + POPOVER_GAP_PX
    popover_right_px.value = window.innerWidth - rect.right
    open.value = true
}

watch(open, (is_open) => {
    if (is_open) {
        listeners_attach()

        return
    }

    listeners_detach()
})

onBeforeUnmount(listeners_detach)
</script>

<template>
    <div ref="root_ref" class="menu shrink-0">
        <button
            type="button"
            class="menu-icon-btn"
            aria-haspopup="menu"
            :aria-expanded="open"
            :aria-label="`Options for ${props.label}`"
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
                ref="popover_ref"
                class="menu-popover menu-popover-fixed"
                role="menu"
                :style="popover_style"
            >
                <li v-for="item in props.items" :key="item.id">
                    <button
                        type="button"
                        :class="['menu-item', item.danger ? 'menu-item-danger' : '']"
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
