import { computed, watch } from 'vue'
import { assert } from '../lib/assert'
import {
    PALETTE_DEFAULT,
    palette_apply_to_html,
    system_media_query,
    theme_apply_to_html,
    theme_resolve,
    theme_storage_write,
} from '../lib/theme'
import { use_settings } from './use_settings'
import type { ThemeEffective } from '../lib/theme'
import type { PaletteChoice, ThemeChoice } from '../types'


export interface PaletteSwatch {
    surface: string
    accent: string
}

export interface Palette {
    id: PaletteChoice
    label: string
    dark: PaletteSwatch
    light: PaletteSwatch
}

export const PALETTES = Object.freeze<Palette[]>([
    {
        id: 'graphite',
        label: 'Graphite',
        dark: { surface: '#0b0b0b', accent: '#39b0dc' },
        light: { surface: '#f7f7f6', accent: '#1a7ea6' },
    },
    {
        id: 'rose-pine',
        label: 'Rosé Pine',
        dark: { surface: '#191724', accent: '#c4a7e7' },
        light: { surface: '#faf4ed', accent: '#7b6693' },
    },
    {
        id: 'catppuccin',
        label: 'Catppuccin',
        dark: { surface: '#1e1e2e', accent: '#cba6f7' },
        light: { surface: '#eff1f5', accent: '#8839ef' },
    },
    {
        id: 'nord',
        label: 'Nord',
        dark: { surface: '#2e3440', accent: '#88c0d0' },
        light: { surface: '#eceff4', accent: '#5e81ac' },
    },
    {
        id: 'gruvbox',
        label: 'Gruvbox',
        dark: { surface: '#282828', accent: '#fe8019' },
        light: { surface: '#fbf1c7', accent: '#af3a03' },
    },
    {
        id: 'tokyo-night',
        label: 'Tokyo Night',
        dark: { surface: '#1a1b26', accent: '#7aa2f7' },
        light: { surface: '#e1e2e7', accent: '#2e7de9' },
    },
    {
        id: 'flexoki',
        label: 'Flexoki',
        dark: { surface: '#100f0f', accent: '#4385be' },
        light: { surface: '#fffcf0', accent: '#205ea6' },
    },
    {
        id: 'ayu',
        label: 'Ayu',
        dark: { surface: '#0b0e14', accent: '#59c2ff' },
        light: { surface: '#fcfcfc', accent: '#1a6fb0' },
    },
    {
        id: 'dracula',
        label: 'Dracula',
        dark: { surface: '#21222c', accent: '#8be9fd' },
        light: { surface: '#fffbeb', accent: '#036a96' },
    },
    {
        id: 'one',
        label: 'One',
        dark: { surface: '#21252b', accent: '#61afef' },
        light: { surface: '#fafafa', accent: '#2a5bcc' },
    },
    {
        id: 'iceberg',
        label: 'Iceberg',
        dark: { surface: '#161821', accent: '#84a0c6' },
        light: { surface: '#e8e9ec', accent: '#2d539e' },
    },
    {
        id: 'nightfox',
        label: 'Nightfox',
        dark: { surface: '#131a24', accent: '#719cd6' },
        light: { surface: '#f6f2ee', accent: '#2848a9' },
    },
    {
        id: 'night-owl',
        label: 'Night Owl',
        dark: { surface: '#011627', accent: '#82aaff' },
        light: { surface: '#fbfbfb', accent: '#3a63bf' },
    },
])

const { settings, update } = use_settings()
const palette_effective = computed<PaletteChoice>(() => settings.value.palette ?? PALETTE_DEFAULT)
const theme_effective = computed<ThemeEffective>(() => theme_resolve(settings.value.theme))


watch(
    () => settings.value.theme,
    (choice) => {
        theme_apply_to_html(theme_resolve(choice))
        theme_storage_write(choice)
    },
    { immediate: true },
)

watch(
    () => settings.value.palette,
    (palette) => {
        palette_apply_to_html(palette ?? PALETTE_DEFAULT)
    },
    { immediate: true },
)

export function use_theme(): typeof api {
    assert(Object.isFrozen(api))
    assert(typeof palette_effective.value === 'string')

    return api
}

listener_system_attach()

function listener_system_attach(): void {
    const query = system_media_query()

    if (query === null) return

    assert(typeof query.addEventListener === 'function')
    assert(PALETTES.length > 0)

    query.addEventListener('change', () => {
        if (settings.value.theme === null) theme_apply_to_html(theme_resolve(null))
    })
}

function palette_set(palette: PaletteChoice): void {
    assert(palette.length > 0)
    assert(PALETTES.some((candidate) => candidate.id === palette))

    void update({ palette })
    palette_apply_to_html(palette)
}

function theme_set(choice: ThemeChoice): void {
    assert(choice.length > 0)
    assert(typeof update === 'function')

    const next = choice === 'system' ? null : choice

    void update({ theme: next })
    theme_apply_to_html(theme_resolve(next))
    theme_storage_write(next)
}

const api = Object.freeze({
    theme_set,
    theme_toggle,
    theme_effective,
    palette_set,
    palette_effective,
})

function theme_toggle(): void {
    assert(theme_effective.value.length > 0)
    assert(typeof settings.value === 'object')

    theme_set(theme_effective.value === 'light' ? 'dark' : 'light')
}
