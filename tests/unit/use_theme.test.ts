import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assert } from '../../src/lib/assert'
import { THEME_STORAGE_KEY } from '../../src/lib/theme'
import { ADD_EVENT_LISTENER } from './fixtures'
import type { use_settings } from '../../src/composables/use_settings'
import type { use_theme } from '../../src/composables/use_theme'
import type { ipc as ipc_contract } from '../../src/lib/ipc'


vi.mock('../../src/lib/ipc')

const change_listeners = new Set<ChangeListener>()


type ChangeListener = () => void
type ThemeHarness = ReturnType<typeof use_settings> & ReturnType<typeof use_theme> & {
    ipc: typeof ipc_contract
}

interface MediaQueryMatches {
    matches: boolean
}

type MediaQueryStub = MediaQueryMatches
    & Record<typeof ADD_EVENT_LISTENER, typeof change_listener_add>

function change_listener_add(name: string, listener: ChangeListener): void {
    assert(name === 'change')
    assert(typeof listener === 'function')

    change_listeners.add(listener)
}

async function flush(): Promise<void> {
    assert(typeof setTimeout === 'function')
    assert(change_listeners.size >= 0)

    return new Promise((resolve) => {
        setTimeout(resolve, 0)
    })
}

function match_media_install(query: MediaQueryStub): void {
    assert(typeof query.matches === 'boolean')
    assert(typeof query.addEventListener === 'function')

    vi.stubGlobal('matchMedia', vi.fn(() => query))
}

function media_query_stub(matches: boolean): MediaQueryStub {
    assert(typeof matches === 'boolean')
    assert(change_listeners.size >= 0)

    return { matches, [ADD_EVENT_LISTENER]: change_listener_add }
}

async function theme_import(): Promise<ThemeHarness> {
    assert(typeof vi.resetModules === 'function')

    vi.resetModules()

    const [{ ipc }, settings_module, theme_module] = await Promise.all([
        import('../../src/lib/ipc'),
        import('../../src/composables/use_settings'),
        import('../../src/composables/use_theme'),
    ])

    vi.mocked(ipc.settings_update).mockResolvedValue(undefined)

    assert(typeof ipc.settings_update === 'function')

    return { ipc, ...settings_module.use_settings(), ...theme_module.use_theme() }
}

beforeEach(() => {
    localStorage.clear()
    change_listeners.clear()
    document.documentElement.className = ''
    document.documentElement.style.colorScheme = ''
    delete document.documentElement.dataset['palette']
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('use_theme on load', () => {
    it('applies the system theme and the default palette immediately', async () => {
        match_media_install(media_query_stub(true))

        const theme = await theme_import()

        expect(theme.theme_effective.value).toBe('light')
        expect(theme.palette_effective.value).toBe('graphite')
        expect(document.documentElement.classList.contains('theme-light')).toBe(true)
        expect(document.documentElement.dataset['palette']).toBe('graphite')
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    })

    it('follows a later system change while the choice is system', async () => {
        const query = media_query_stub(false)

        match_media_install(query)
        const theme = await theme_import()

        expect(theme.theme_effective.value).toBe('dark')

        query.matches = true

        for (const listener of change_listeners) listener()

        expect(document.documentElement.classList.contains('theme-light')).toBe(true)
    })

    it('ignores a system change once an explicit theme is set', async () => {
        const query = media_query_stub(false)

        match_media_install(query)
        const theme = await theme_import()

        theme.theme_set('dark')
        await flush()
        query.matches = true

        for (const listener of change_listeners) listener()

        expect(document.documentElement.classList.contains('theme-dark')).toBe(true)
        expect(document.documentElement.classList.contains('theme-light')).toBe(false)
    })
})

describe('theme_set', () => {
    it('persists an explicit choice to the backend, the html and local storage', async () => {
        match_media_install(media_query_stub(true))

        const theme = await theme_import()

        theme.theme_set('dark')
        await flush()

        expect(theme.ipc.settings_update).toHaveBeenCalledWith(
            expect.objectContaining({ theme: 'dark' }),
        )

        expect(document.documentElement.classList.contains('theme-dark')).toBe(true)
        expect(document.documentElement.style.colorScheme).toBe('dark')
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    })

    it('stores system as null and clears local storage', async () => {
        match_media_install(media_query_stub(true))

        const theme = await theme_import()

        theme.theme_set('dark')
        await flush()
        theme.theme_set('system')
        await flush()

        expect(theme.ipc.settings_update).toHaveBeenLastCalledWith(
            expect.objectContaining({ theme: null }),
        )

        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
        expect(document.documentElement.classList.contains('theme-light')).toBe(true)
    })
})

describe('theme_toggle', () => {
    it('flips between light and dark from the effective theme', async () => {
        match_media_install(media_query_stub(true))

        const theme = await theme_import()

        theme.theme_toggle()
        await flush()

        expect(theme.settings.value.theme).toBe('dark')
        expect(theme.theme_effective.value).toBe('dark')

        theme.theme_toggle()
        await flush()

        expect(theme.settings.value.theme).toBe('light')
        expect(document.documentElement.classList.contains('theme-light')).toBe(true)
    })
})

describe('palette_set', () => {
    it('persists the palette and writes it to the html', async () => {
        match_media_install(media_query_stub(false))

        const theme = await theme_import()

        theme.palette_set('nord')
        await flush()

        expect(theme.ipc.settings_update).toHaveBeenCalledWith(
            expect.objectContaining({ palette: 'nord' }),
        )

        expect(document.documentElement.dataset['palette']).toBe('nord')
        expect(theme.palette_effective.value).toBe('nord')
    })
})
