import { assert } from './assert'
import type { PaletteChoice, ThemeChoice } from '../types'


export type ModeEffective = 'light' | 'dark'

export const MODE_STORAGE_KEY = 'remi.mode'
export const PALETTE_STORAGE_KEY = 'remi.palette'
const STORAGE_KEY_PREFIX = 'remi.'
const SYSTEM_MEDIA_QUERY = '(prefers-color-scheme: light)'
export const THEME_DEFAULT: ThemeChoice = 'cubism'
export const THEME_STORAGE_KEY = 'remi.theme'


export function mode_apply_to_html(effective: ModeEffective): void {
    assert(['dark', 'light'].includes(effective))
    assert(effective.length > 0)

    if (typeof document === 'undefined') return

    const root = document.documentElement

    root.classList.toggle('mode-light', effective === 'light')
    root.classList.toggle('mode-dark', effective === 'dark')
    root.style.colorScheme = effective
}

export function mode_resolve(choice: string | null): ModeEffective {
    assert(choice === null || typeof choice === 'string')

    if (choice === 'light') return 'light'
    if (choice === 'dark') return 'dark'

    const query = system_media_query()

    if (query === null) return 'dark'

    assert(typeof query.matches === 'boolean')

    return query.matches ? 'light' : 'dark'
}

export function palette_apply_to_html(palette: PaletteChoice): void {
    assert(typeof palette === 'string')
    assert(palette.length > 0)

    if (typeof document === 'undefined') return

    document.documentElement.dataset['palette'] = palette
}

export function storage_read(key: string): string | null {
    assert(key.startsWith(STORAGE_KEY_PREFIX))
    assert(key.length > STORAGE_KEY_PREFIX.length)

    if (typeof localStorage === 'undefined') return null

    return localStorage.getItem(key)
}

export function storage_write(key: string, value: string | null): void {
    assert(key.startsWith(STORAGE_KEY_PREFIX))
    assert(value === null || typeof value === 'string')

    if (typeof localStorage === 'undefined') return

    if (value === null) {
        localStorage.removeItem(key)

        return
    }

    localStorage.setItem(key, value)
}

export function system_media_query(): MediaQueryList | null {
    if (typeof window === 'undefined') return null
    if (typeof window.matchMedia !== 'function') return null

    assert(SYSTEM_MEDIA_QUERY.length > 0)
    assert(SYSTEM_MEDIA_QUERY.startsWith('('))

    return window.matchMedia(SYSTEM_MEDIA_QUERY)
}

export function theme_apply_to_html(theme: ThemeChoice): void {
    assert(typeof theme === 'string')
    assert(theme.length > 0)

    if (typeof document === 'undefined') return

    document.documentElement.dataset['theme'] = theme
}
