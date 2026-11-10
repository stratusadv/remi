import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assert } from '../../src/lib/assert'
import {
    PALETTE_DEFAULT,
    THEME_STORAGE_KEY,
    palette_apply_to_html,
    system_media_query,
    theme_apply_to_html,
    theme_resolve,
    theme_storage_read,
    theme_storage_write,
} from '../../src/lib/theme'
import type { Mock } from 'vitest'


type MediaQueryStub = Pick<MediaQueryList, 'matches' | 'media'>

function match_media_stub(matches: boolean): Mock<(query: string) => MediaQueryStub> {
    assert(typeof matches === 'boolean')
    assert(typeof vi.fn === 'function')

    return vi.fn((query: string) => ({ matches, media: query }))
}

beforeEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('system_media_query', () => {
    it('returns null when matchMedia is not a function', () => {
        vi.stubGlobal('matchMedia', undefined)

        expect(system_media_query()).toBeNull()
    })

    it('queries for a light colour scheme preference', () => {
        const stub = match_media_stub(false)

        vi.stubGlobal('matchMedia', stub)

        expect(system_media_query()).not.toBeNull()
        expect(stub).toHaveBeenCalledWith('(prefers-color-scheme: light)')
    })
})

describe('theme_resolve', () => {
    it('honours an explicit light or dark choice without consulting the system', () => {
        const stub = match_media_stub(true)

        vi.stubGlobal('matchMedia', stub)

        expect(theme_resolve('light')).toBe('light')
        expect(theme_resolve('dark')).toBe('dark')
        expect(stub).not.toHaveBeenCalled()
    })

    it('follows the system preference when the choice is system or null', () => {
        vi.stubGlobal('matchMedia', match_media_stub(true))

        expect(theme_resolve('system')).toBe('light')
        expect(theme_resolve(null)).toBe('light')

        vi.stubGlobal('matchMedia', match_media_stub(false))

        expect(theme_resolve('system')).toBe('dark')
        expect(theme_resolve(null)).toBe('dark')
    })

    it('defaults to dark when the system preference is unavailable', () => {
        vi.stubGlobal('matchMedia', undefined)

        expect(theme_resolve(null)).toBe('dark')
        expect(theme_resolve('system')).toBe('dark')
    })
})

describe('theme_storage_read', () => {
    it('returns null when nothing is stored', () => {
        expect(theme_storage_read()).toBeNull()
    })

    it('returns the stored light or dark choice', () => {
        localStorage.setItem(THEME_STORAGE_KEY, 'light')

        expect(theme_storage_read()).toBe('light')

        localStorage.setItem(THEME_STORAGE_KEY, 'dark')

        expect(theme_storage_read()).toBe('dark')
    })

    it('treats any other stored value as null', () => {
        localStorage.setItem(THEME_STORAGE_KEY, 'system')

        expect(theme_storage_read()).toBeNull()

        localStorage.setItem(THEME_STORAGE_KEY, 'purple')

        expect(theme_storage_read()).toBeNull()
    })
})

describe('theme_storage_write', () => {
    it('stores light and dark under the theme key', () => {
        theme_storage_write('light')

        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')

        theme_storage_write('dark')

        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    })

    it('removes the key for system and null', () => {
        theme_storage_write('dark')
        theme_storage_write('system')

        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()

        theme_storage_write('dark')
        theme_storage_write(null)

        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    })
})

describe('theme_apply_to_html', () => {
    it('sets the light class and colour scheme and clears the dark class', () => {
        const root = document.documentElement

        root.classList.add('theme-dark')
        theme_apply_to_html('light')

        expect(root.classList.contains('theme-light')).toBe(true)
        expect(root.classList.contains('theme-dark')).toBe(false)
        expect(root.style.colorScheme).toBe('light')
    })

    it('sets the dark class and colour scheme and clears the light class', () => {
        const root = document.documentElement

        root.classList.add('theme-light')
        theme_apply_to_html('dark')

        expect(root.classList.contains('theme-dark')).toBe(true)
        expect(root.classList.contains('theme-light')).toBe(false)
        expect(root.style.colorScheme).toBe('dark')
    })
})

describe('palette_apply_to_html', () => {
    it('writes the palette to the root data attribute', () => {
        palette_apply_to_html('nord')

        expect(document.documentElement.dataset['palette']).toBe('nord')

        palette_apply_to_html(PALETTE_DEFAULT)

        expect(document.documentElement.dataset['palette']).toBe('graphite')
    })
})
