import { computed, watch } from 'vue'
import { action_report } from '../lib/actions'
import { assert } from '../lib/assert'
import {
    MODE_STORAGE_KEY,
    PALETTE_STORAGE_KEY,
    THEME_DEFAULT,
    THEME_STORAGE_KEY,
    mode_apply_to_html,
    mode_resolve,
    palette_apply_to_html,
    storage_read,
    storage_write,
    system_media_query,
    theme_apply_to_html,
} from '../lib/theme'
import { use_settings } from './use_settings'
import type { ModeEffective } from '../lib/theme'
import type { ModeChoice, PaletteChoice, Settings, ThemeChoice } from '../types'


interface AppearanceSaved {
    mode: string | null
    theme: string | null
    palette: string | null
}

export interface Palette {
    id: PaletteChoice
    label: string
}

export interface Theme {
    id: ThemeChoice
    label: string
    palette: PaletteChoice
}

export const PALETTES = Object.freeze<Palette[]>([
    { id: 'cubist', label: 'Cubist' },
    { id: 'graphite', label: 'Graphite' },
    { id: 'rose-pine', label: 'Rosé Pine' },
    { id: 'catppuccin', label: 'Catppuccin' },
    { id: 'nord', label: 'Nord' },
    { id: 'gruvbox', label: 'Gruvbox' },
    { id: 'tokyo-night', label: 'Tokyo Night' },
    { id: 'flexoki', label: 'Flexoki' },
    { id: 'ayu', label: 'Ayu' },
    { id: 'dracula', label: 'Dracula' },
    { id: 'one', label: 'One' },
    { id: 'iceberg', label: 'Iceberg' },
    { id: 'nightfox', label: 'Nightfox' },
    { id: 'night-owl', label: 'Night Owl' },
])

export const THEMES = Object.freeze<Theme[]>([
    { id: 'cubism', label: 'Cubism', palette: 'cubist' },
    { id: 'standard', label: 'Standard', palette: 'graphite' },
])

const { settings, update } = use_settings()
const mode_effective = computed<ModeEffective>(() => mode_resolve(settings.value.mode))
const theme_effective = computed<ThemeChoice>(() => theme_resolve(settings.value.theme))

const palette_effective = computed<PaletteChoice>(() =>
    palette_resolve(settings.value.palette, theme_effective.value))

const api = Object.freeze({
    mode_effective,
    mode_set,
    mode_toggle,
    palette_effective,
    palette_set,
    theme_effective,
    theme_set,
})


appearance_apply({
    mode: storage_read(MODE_STORAGE_KEY),
    theme: storage_read(THEME_STORAGE_KEY),
    palette: storage_read(PALETTE_STORAGE_KEY),
})

watch(settings, settings_apply)

listener_system_attach()

function appearance_apply(saved: Readonly<AppearanceSaved>): void {
    assert(saved.mode === null || typeof saved.mode === 'string')
    assert(saved.theme === null || typeof saved.theme === 'string')
    assert(saved.palette === null || typeof saved.palette === 'string')

    const theme_applied = theme_resolve(saved.theme)
    const palette_applied = palette_resolve(saved.palette, theme_applied)

    mode_apply_to_html(mode_resolve(saved.mode))
    theme_apply_to_html(theme_applied)
    palette_apply_to_html(palette_applied)

    assert(THEMES.some((candidate) => candidate.id === theme_applied))
    assert(PALETTES.some((candidate) => candidate.id === palette_applied))
}

function listener_system_attach(): void {
    const query = system_media_query()

    if (query === null) return

    assert(typeof query.addEventListener === 'function')
    assert(typeof query.matches === 'boolean')

    query.addEventListener('change', () => {
        if (settings.value.mode === null) mode_apply_to_html(mode_resolve(null))
    })
}

function mode_set(choice: ModeChoice): void {
    assert(choice.length > 0)
    assert(typeof update === 'function')

    const next = choice === 'system' ? null : choice

    if (next !== settings.value.mode) action_report('change-theme')

    void update({ mode: next })
    mode_apply_to_html(mode_resolve(next))
}

function mode_toggle(): void {
    assert(mode_effective.value.length > 0)
    assert(typeof settings.value === 'object')

    mode_set(mode_effective.value === 'light' ? 'dark' : 'light')
}

export function palette_resolve(saved: string | null, theme: ThemeChoice): PaletteChoice {
    assert(saved === null || typeof saved === 'string')
    assert(THEMES.some((candidate) => candidate.id === theme))

    const known = PALETTES.find((candidate) => candidate.id === saved)

    if (known !== undefined) return known.id

    const owner = THEMES.find((candidate) => candidate.id === theme)

    assert(owner !== undefined, `the ${theme} theme is not in THEMES`)

    return owner.palette
}

function palette_set(palette: PaletteChoice): void {
    assert(palette.length > 0)
    assert(PALETTES.some((candidate) => candidate.id === palette))

    if (palette !== palette_effective.value) action_report('change-theme')

    void update({ palette })
    palette_apply_to_html(palette)
}

function settings_apply(current: Readonly<Settings>): void {
    assert(typeof current === 'object')
    assert(current === settings.value)

    appearance_apply(current)

    storage_write(MODE_STORAGE_KEY, current.mode)
    storage_write(PALETTE_STORAGE_KEY, current.palette)
    storage_write(THEME_STORAGE_KEY, current.theme)
}

export function theme_resolve(saved: string | null): ThemeChoice {
    assert(saved === null || typeof saved === 'string')
    assert(THEMES.some((candidate) => candidate.id === THEME_DEFAULT))

    const known = THEMES.find((candidate) => candidate.id === saved)

    return known === undefined ? THEME_DEFAULT : known.id
}

function theme_set(theme: ThemeChoice): void {
    assert(theme.length > 0)
    assert(THEMES.some((candidate) => candidate.id === theme))

    if (theme !== theme_effective.value) action_report('change-theme')

    void update({ theme, palette: null })
    theme_apply_to_html(theme)
    palette_apply_to_html(palette_resolve(null, theme))
}

export function use_theme(): typeof api {
    assert(THEMES.some((candidate) => candidate.id === theme_effective.value))
    assert(typeof palette_effective.value === 'string')

    return api
}
