<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'


export interface RowMenuItem {
    id: string
    label: string
    icon: 'edit' | 'delete' | 'star'
    danger?: boolean
}

const props = defineProps<{
    label: string
    items: RowMenuItem[]
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

const ICON_PATH_PEN = 'M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82'
    + 'a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z'

const ICON_PATH_STAR = 'M11.48 3.5a.56.56 0 0 1 1.04 0l2.12 5.11a.56.56 0 0 0 .48.35l5.52.44'
    + 'c.5.04.7.66.32.99l-4.2 3.6a.56.56 0 0 0-.18.56l1.28 5.39a.56.56 0 0 1-.84.61'
    + 'l-4.73-2.89a.56.56 0 0 0-.58 0l-4.73 2.89a.56.56 0 0 1-.84-.61l1.28-5.39'
    + 'a.56.56 0 0 0-.18-.56l-4.2-3.6a.56.56 0 0 1 .32-.99l5.52-.44a.56.56 0 0 0 .48-.35'
    + 'L11.48 3.5Z'

const ICON_PATHS: Record<RowMenuItem['icon'], string[]> = {
    edit: [
        ICON_PATH_PEN,
        'M16.862 4.487 19.5 7.125',
    ],
    delete: [
        'M4.5 6.75h15',
        'M9.75 6.75V4.5h4.5v2.25',
        'M6.75 6.75l.75 12.75h9l.75-12.75',
        'M10.5 10.5v5.25',
        'M13.5 10.5v5.25',
    ],
    star: [
        ICON_PATH_STAR,
    ],
}


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
                        <svg
                            class="menu-item-icon"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <path
                                v-for="(path_data, index) in ICON_PATHS[item.icon]"
                                :key="index"
                                :d="path_data"
                            />
                        </svg>
                        {{ item.label }}
                    </button>
                </li>
            </ul>
        </Teleport>
    </div>
</template>
