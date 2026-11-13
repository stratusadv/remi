import { assert } from './assert'
import type { PaletteChoice, ThemeChoice } from '../types'


export type ThemeEffective = 'light' | 'dark'

export const PALETTE_DEFAULT: PaletteChoice = 'cubist'
const SYSTEM_MEDIA_QUERY = '(prefers-color-scheme: light)'
export const THEME_STORAGE_KEY = 'remi.theme'


export function palette_apply_to_html(palette: PaletteChoice): void {
    assert(typeof palette === 'string')
    assert(PALETTE_DEFAULT.length > 0)

    if (typeof document === 'undefined') return

    document.documentElement.dataset['palette'] = palette
}

export function system_media_query(): MediaQueryList | null {
    if (typeof window === 'undefined') return null
    if (typeof window.matchMedia !== 'function') return null

    assert(SYSTEM_MEDIA_QUERY.length > 0)
    assert(SYSTEM_MEDIA_QUERY.startsWith('('))

    return window.matchMedia(SYSTEM_MEDIA_QUERY)
}

export function theme_apply_to_html(effective: ThemeEffective): void {
    assert(['dark', 'light'].includes(effective))
    assert(effective.length > 0)

    if (typeof document === 'undefined') return

    const root = document.documentElement

    root.classList.toggle('theme-light', effective === 'light')
    root.classList.toggle('theme-dark', effective === 'dark')
    root.style.colorScheme = effective
}

export function theme_resolve(choice: ThemeChoice | null): ThemeEffective {
    assert(choice === null || typeof choice === 'string')

    if (choice === 'light') return 'light'
    if (choice === 'dark') return 'dark'

    const query = system_media_query()

    if (query === null) return 'dark'

    assert(typeof query.matches === 'boolean')

    return query.matches ? 'light' : 'dark'
}

export function theme_storage_read(): ThemeChoice | null {
    assert(THEME_STORAGE_KEY.length > 0)

    if (typeof localStorage === 'undefined') return null

    const stored = localStorage.getItem(THEME_STORAGE_KEY)

    assert(stored === null || typeof stored === 'string')

    if (stored === 'light') return 'light'
    if (stored === 'dark') return 'dark'

    return null
}

export function theme_storage_write(choice: ThemeChoice | null): void {
    assert(choice === null || typeof choice === 'string')
    assert(THEME_STORAGE_KEY.length > 0)

    if (typeof localStorage === 'undefined') return

    switch (choice) {
        case 'light':
        case 'dark':
            localStorage.setItem(THEME_STORAGE_KEY, choice)

            return
        case 'system':
        case null:
        default:
            localStorage.removeItem(THEME_STORAGE_KEY)
    }
}
