import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assert } from '../../src/lib/assert'
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

describe('mode_resolve', () => {
    it('honours an explicit light or dark choice without consulting the system', () => {
        const stub = match_media_stub(true)

        vi.stubGlobal('matchMedia', stub)

        expect(mode_resolve('light')).toBe('light')
        expect(mode_resolve('dark')).toBe('dark')
        expect(stub).not.toHaveBeenCalled()
    })

    it('follows the system preference when the choice is system, null, or unknown', () => {
        vi.stubGlobal('matchMedia', match_media_stub(true))

        expect(mode_resolve('system')).toBe('light')
        expect(mode_resolve(null)).toBe('light')
        expect(mode_resolve('purple')).toBe('light')

        vi.stubGlobal('matchMedia', match_media_stub(false))

        expect(mode_resolve('system')).toBe('dark')
        expect(mode_resolve(null)).toBe('dark')
        expect(mode_resolve('purple')).toBe('dark')
    })

    it('defaults to dark when the system preference is unavailable', () => {
        vi.stubGlobal('matchMedia', undefined)

        expect(mode_resolve(null)).toBe('dark')
        expect(mode_resolve('system')).toBe('dark')
    })
})

describe('storage_read and storage_write', () => {
    it('reads null for a key that was never written', () => {
        expect(storage_read(MODE_STORAGE_KEY)).toBeNull()
        expect(storage_read(PALETTE_STORAGE_KEY)).toBeNull()
        expect(storage_read(THEME_STORAGE_KEY)).toBeNull()
    })

    it('reads back each value under its own key', () => {
        storage_write(MODE_STORAGE_KEY, 'light')
        storage_write(PALETTE_STORAGE_KEY, 'nord')
        storage_write(THEME_STORAGE_KEY, 'standard')

        expect(storage_read(MODE_STORAGE_KEY)).toBe('light')
        expect(storage_read(PALETTE_STORAGE_KEY)).toBe('nord')
        expect(storage_read(THEME_STORAGE_KEY)).toBe('standard')
        expect(localStorage.length).toBe(3)
    })

    it('removes the key when the value is null', () => {
        storage_write(THEME_STORAGE_KEY, 'standard')
        storage_write(THEME_STORAGE_KEY, null)

        expect(storage_read(THEME_STORAGE_KEY)).toBeNull()
        expect(localStorage.length).toBe(0)
    })

    it('refuses a key outside the remi namespace', () => {
        expect(() => storage_read('theme')).toThrow()

        expect(() => {
            storage_write('theme', 'dark')
        }).toThrow()

        expect(localStorage.length).toBe(0)
    })
})

describe('mode_apply_to_html', () => {
    it('sets the light class and colour scheme and clears the dark class', () => {
        const root = document.documentElement

        root.classList.add('mode-dark')
        mode_apply_to_html('light')

        expect(root.classList.contains('mode-light')).toBe(true)
        expect(root.classList.contains('mode-dark')).toBe(false)
        expect(root.style.colorScheme).toBe('light')
    })

    it('sets the dark class and colour scheme and clears the light class', () => {
        const root = document.documentElement

        root.classList.add('mode-light')
        mode_apply_to_html('dark')

        expect(root.classList.contains('mode-dark')).toBe(true)
        expect(root.classList.contains('mode-light')).toBe(false)
        expect(root.style.colorScheme).toBe('dark')
    })
})

describe('theme_apply_to_html', () => {
    it('writes the theme to the root data attribute', () => {
        theme_apply_to_html('standard')

        expect(document.documentElement.dataset['theme']).toBe('standard')

        theme_apply_to_html(THEME_DEFAULT)

        expect(document.documentElement.dataset['theme']).toBe('cubism')
    })
})

describe('palette_apply_to_html', () => {
    it('writes the palette to the root data attribute', () => {
        palette_apply_to_html('nord')

        expect(document.documentElement.dataset['palette']).toBe('nord')

        palette_apply_to_html('graphite')

        expect(document.documentElement.dataset['palette']).toBe('graphite')
    })
})
