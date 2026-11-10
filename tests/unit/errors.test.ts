import { describe, expect, it } from 'vitest'
import { use_dialog } from '../../src/composables/use_dialog'
import { assert } from '../../src/lib/assert'
import { error_dialog_show, error_friendly, error_text_extract } from '../../src/lib/errors'


function named_failure(): number {
    const failure = Number.NaN

    assert(Number.isNaN(failure))
    assert(typeof failure === 'number')

    return 0
}

describe('error_friendly', () => {
    it('explains a network error and keeps the detail in brackets', () => {
        const friendly = error_friendly('network error: connection refused')

        expect(friendly.kind).toBe('network')
        expect(friendly.title).toBe('Network problem')

        expect(friendly.message).toBe(
            'The server could not be reached. Check your internet connection and try again. '
            + '(connection refused)',
        )
    })

    it('recognises a reply that stopped part-way through', () => {
        const friendly = error_friendly(
            'network error: error decoding response body: unexpected EOF',
        )

        expect(friendly.kind).toBe('network')
        expect(friendly.title).toBe('The server stopped responding')

        expect(friendly.message).toBe(
            'The server stopped part-way through its reply. It may be busy; wait a minute and '
            + 'try again. (error decoding response body: unexpected EOF)',
        )
    })

    it('strips the api prefix and reports a rejection', () => {
        const friendly = error_friendly('API error: 401 unauthorized')

        expect(friendly).toEqual({
            title: 'The server rejected the request',
            message: '401 unauthorized',
            kind: 'api',
        })
    })

    it('strips the config prefix and reports a configuration issue', () => {
        const friendly = error_friendly(new Error('config error: missing api key'))

        expect(friendly).toEqual({
            title: 'Configuration issue',
            message: 'missing api key',
            kind: 'config',
        })
    })

    it('matches prefixes case-insensitively', () => {
        expect(error_friendly('NETWORK ERROR: timeout').kind).toBe('network')
        expect(error_friendly('Config Error: bad host').message).toBe('bad host')
    })

    it('falls back to the raw text for anything else', () => {
        expect(error_friendly('disk full')).toEqual({
            title: 'Something went wrong',
            message: 'disk full',
            kind: 'unknown',
        })
    })

    it('does not treat a prefix in the middle of the text as a marker', () => {
        expect(error_friendly('something network error: nested').kind).toBe('unknown')
    })
})

describe('error_text_extract', () => {
    it('returns a string as is', () => {
        expect(error_text_extract('plain')).toBe('plain')
    })

    it('returns the message of an Error', () => {
        expect(error_text_extract(new TypeError('bad type'))).toBe('bad type')
    })

    it('returns the message field of a plain object when it is a string', () => {
        expect(error_text_extract({ message: 'from object', code: 3 })).toBe('from object')
    })

    it('serialises an object without a string message', () => {
        expect(error_text_extract({ code: 3 })).toBe('{"code":3}')
        expect(error_text_extract({ message: 42 })).toBe('{"message":42}')
    })

    it('names null and undefined', () => {
        expect(error_text_extract(null)).toBe('null')
        expect(error_text_extract(undefined)).toBe('undefined')
    })

    it('uses the name of a function', () => {
        expect(error_text_extract(named_failure)).toBe('named_failure')
    })

    it('uses the description of a symbol', () => {
        expect(error_text_extract(Symbol('tag'))).toBe('tag')
        expect(error_text_extract(Symbol())).toBe('symbol')
    })

    it('stringifies numbers, booleans and bigints', () => {
        expect(error_text_extract(12)).toBe('12')
        expect(error_text_extract(false)).toBe('false')
        expect(error_text_extract(9n)).toBe('9')
    })
})

describe('error_dialog_show', () => {
    it('opens an error dialog for network and unknown kinds', async () => {
        const { current, close } = use_dialog()
        const pending = error_dialog_show('network error: offline')

        expect(current.value?.kind).toBe('error')
        expect(current.value?.title).toBe('Network problem')
        expect(current.value?.cancel_label).toBeNull()

        close(true)
        await pending

        expect(current.value).toBeNull()
    })

    it('opens a warning dialog for api and config kinds', async () => {
        const { current, close } = use_dialog()
        const pending = error_dialog_show('api error: 500')

        expect(current.value?.kind).toBe('warning')
        expect(current.value?.message).toBe('500')

        close(true)
        await pending
    })
})
