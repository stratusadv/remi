import { afterEach, describe, expect, it, vi } from 'vitest'
import { use_dialog } from '../../src/composables/use_dialog'
import { is_cancelled_error } from '../../src/composables/use_tasks'
import { AssertionError, assert } from '../../src/lib/assert'
import {
    IPCError,
    error_dialog_show,
    error_friendly,
    error_shown,
    error_text_extract,
} from '../../src/lib/errors'


const MESSAGE_LENGTH_MAX = 400
const MESSAGE_UNSHOWN = 'remi ran into a problem it cannot show here. The details are in its log.'

const TRACEBACK = 'api error: 500 transcription charge: Traceback (most recent call last):\n'
    + '  File "/app/server/app/account/services/processor_service.py", line 187\n'
    + 'psycopg.errors.UndefinedColumn: column "account"."is_complimentary" does not exist'


function named_failure(): number {
    const failure = Number.NaN

    assert(Number.isNaN(failure))
    assert(typeof failure === 'number')

    return 0
}

describe('error_friendly', () => {
    it('explains a network error and leaves its technical detail to the log', () => {
        const friendly = error_friendly('network error: connection refused')

        expect(friendly.kind).toBe('network')
        expect(friendly.title).toBe('Network problem')

        expect(friendly.message).toBe(
            'The server could not be reached. Check your internet connection and try again.',
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
            + 'try again.',
        )
    })

    it('strips the api prefix and reports a rejection as a sentence', () => {
        const friendly = error_friendly('API error: 401 unauthorized')

        expect(friendly).toEqual({
            title: 'The server rejected the request',
            message: '401 unauthorized.',
            kind: 'api',
        })
    })

    it('strips the config prefix and reports a configuration issue as a sentence', () => {
        const friendly = error_friendly(new Error('config error: missing api key'))

        expect(friendly).toEqual({
            title: 'Configuration issue',
            message: 'Missing api key.',
            kind: 'config',
        })
    })

    it('matches prefixes case-insensitively', () => {
        expect(error_friendly('NETWORK ERROR: timeout').kind).toBe('network')
        expect(error_friendly('Config Error: bad host').message).toBe('Bad host.')
    })

    it('shows the generic sentence for text that no kind of error claims', () => {
        expect(error_friendly('disk full')).toEqual({
            title: 'Something went wrong',
            message: MESSAGE_UNSHOWN,
            kind: 'internal',
        })
    })

    it('does not treat a prefix in the middle of the text as a marker', () => {
        expect(error_friendly('something network error: nested').kind).toBe('internal')
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
        expect(error_text_extract(Symbol(undefined))).toBe('symbol')
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
        expect(current.value?.message).toBe('500.')

        close(true)
        await pending
    })
})

describe('error_friendly on a reply the server could not explain', () => {
    it('drops the status and operation of a server failure and keeps its sentence', () => {
        const sentence = 'The server ran into a problem. Try again in a few minutes. (server_error)'
        const friendly = error_friendly(`api error: 500 transcription charge: ${sentence}`)

        expect(friendly.title).toBe('The server had a problem')
        expect(friendly.message).toBe(sentence)
        expect(friendly.kind).toBe('api')
    })

    it('drops the status and operation of a refusal and keeps its reason', () => {
        const reason = 'The server refused the request (conflict).'
        const friendly = error_friendly(`api error: 409 transcription charge: ${reason}`)

        expect(friendly.title).toBe('The server rejected the request')
        expect(friendly.message).toBe(reason)
    })

    it('never shows a traceback, a page of markup, or a wall of text', () => {
        const hostile = [
            TRACEBACK,
            'api error: 502 model list: <html>\n<body><h1>502 Bad Gateway</h1></body>\n</html>',
            `transcription error: ${'x'.repeat(MESSAGE_LENGTH_MAX)}`,
            new Error(''),
            '   ',
        ]

        for (const raw of hostile) {
            const friendly = error_friendly(raw)

            expect(friendly.message).toBe(MESSAGE_UNSHOWN)
            expect(friendly.message.length).toBeLessThanOrEqual(MESSAGE_LENGTH_MAX)
            expect(friendly.message).not.toMatch(/[\n\r]/u)
            expect(friendly.title.length).toBeGreaterThan(0)
        }
    })
})

describe('IPCError', () => {
    it('reads as its friendly message and keeps the raw text for the log', () => {
        const error = new IPCError({ command: 'transcription_remote', raw: TRACEBACK })

        expect(error).toBeInstanceOf(Error)
        expect(String(error)).toBe(MESSAGE_UNSHOWN)
        expect(error.message).toBe(MESSAGE_UNSHOWN)
        expect(error_text_extract(error)).toBe(MESSAGE_UNSHOWN)
        expect(error_friendly(error)).toBe(error.friendly)
        expect(error.friendly.title).toBe('The server had a problem')
        expect(error.raw).toBe(TRACEBACK)
        expect(error.command).toBe('transcription_remote')
    })

    it('reads as the generic sentence when the framework refused the command', () => {
        const raw = 'invalid args `jobId` for command `job_delete`: expected 32 hex digits'
        const refused = new IPCError({ command: 'job_delete', raw })

        expect(refused.message).toBe(MESSAGE_UNSHOWN)
        expect(refused.friendly.kind).toBe('internal')
        expect(refused.raw).toBe(raw)
    })

    it('still reads as cancelled when the command was cancelled', () => {
        const raw_stopped = 'transcription error: Cancelled'
        const raw_asked = 'api error: Cancelled'
        const raw_refused = 'api error: The balance is too low.'
        const stopped = new IPCError({ command: 'transcription_remote', raw: raw_stopped })
        const asked = new IPCError({ command: 'notes_ask_streaming', raw: raw_asked })
        const refused = new IPCError({ command: 'transcription_remote', raw: raw_refused })

        expect(is_cancelled_error(stopped)).toBe(true)
        expect(is_cancelled_error(asked)).toBe(true)
        expect(is_cancelled_error(refused)).toBe(false)
    })
})

describe('error details too long to show', () => {
    it('keeps the network advice and drops a detail too long to show', () => {
        const query = 'part=1&'.repeat(MESSAGE_LENGTH_MAX)
        const url = `https://api.remirememberthat.com/upload?${query}`
        const friendly = error_friendly(`network error: error sending request for url (${url})`)

        const advice = 'The server could not be reached. Check your internet connection and '
            + 'try again.'

        expect(friendly.title).toBe('Network problem')
        expect(friendly.message).toBe(advice)
    })
})

describe('error_friendly for each kind of desktop error', () => {
    const details = [
        'Permission denied (os error 13)',
        '/home/someone/.local/share/remi/jobs/0f3a/audio.wav',
        'expected value at line 1 column 1',
        'resampler init: ratio out of range',
        'blocking task failed to join: panicked',
    ]

    it('never shows the detail of a file, data, task, search or internal failure', () => {
        const prefixes = [
            'internal error: ',
            'io error: ',
            'search index error: ',
            'serde error: ',
            'task error: ',
        ]

        for (const prefix of prefixes) {
            for (const detail of details) {
                const friendly = error_friendly(`${prefix}${detail}`)

                expect(friendly.message).not.toContain(detail)
                expect(friendly.message).toMatch(/^[A-Zr].*[.]$/u)
                expect(friendly.title.length).toBeGreaterThan(0)
            }
        }
    })

    it('gives every kind its own title', () => {
        const titles = [
            ['audio error: nothing was recorded', 'Audio problem'],
            ['config error: a folder needs a name', 'Configuration issue'],
            ['export error: these notes are empty', 'Export problem'],
            ['internal error: the stream id is empty', 'Something went wrong'],
            ['io error: No space left on device (os error 28)', 'File problem'],
            ['search index error: database is locked', 'Search problem'],
            ['serde error: expected value', 'Something went wrong'],
            ['task error: blocking task failed to join', 'Something went wrong'],
            ['transcription error: no speech came back', 'Transcription problem'],
        ] as const

        for (const [raw, title] of titles) {
            expect(error_friendly(raw).title).toBe(title)
        }
    })
})

describe('error_friendly on a sentence a person wrote', () => {
    it('shows it as one sentence and keeps the name remi lowercase', () => {
        const sentences = [
            {
                raw: 'audio error: nothing was recorded; check the microphone',
                shown: 'Nothing was recorded; check the microphone.',
            },
            {
                raw: 'config error: No API address has been set.',
                shown: 'No API address has been set.',
            },
            {
                raw: 'api error: remi could not get a turn for this question.',
                shown: 'remi could not get a turn for this question.',
            },
            {
                raw: 'export error: is it open?',
                shown: 'Is it open?',
            },
            {
                raw: 'api error: 503 notes: Try again later. (overloaded)',
                shown: 'Try again later. (overloaded)',
            },
        ]

        for (const { raw, shown } of sentences) {
            expect(error_friendly(raw).message).toBe(shown)
        }
    })
})

describe('error_friendly for an error raised in the window', () => {
    it('shows the generic sentence for a programming error', () => {
        const thrown = [
            new AssertionError('an assertion failed'),
            new DOMException('The operation was aborted.', 'AbortError'),
            new TypeError('Cannot read properties of undefined (reading \'id\')'),
            new RangeError('Invalid array length'),
            new ReferenceError('job is not defined'),
            new SyntaxError('Unexpected token < in JSON at position 0'),
        ]

        for (const error of thrown) {
            const friendly = error_friendly(error)

            expect(friendly.message).toBe(MESSAGE_UNSHOWN)
            expect(friendly.kind).toBe('internal')
        }
    })

    it('keeps a sentence the window wrote for the person', () => {
        const written = new Error('Add an API key under Settings first.')

        expect(error_friendly(written).message).toBe('Add an API key under Settings first.')
    })

    it('shows the generic sentence for a failure a plugin reported as text', () => {
        const reported = 'failed to open the file dialog: org.freedesktop.portal.Error.Failed'

        expect(error_friendly(reported).message).toBe(MESSAGE_UNSHOWN)
        expect(error_friendly('config error: bad host').message).toBe('Bad host.')
    })
})

describe('error_shown', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('logs an error the IPC layer did not log and returns its sentence', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const thrown = new TypeError('job is undefined')

        expect(error_shown(thrown)).toBe(MESSAGE_UNSHOWN)
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn).toHaveBeenCalledWith('[error] shown to the user', thrown)
    })

    it('does not log an IPC failure a second time', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const failure = new IPCError({ command: 'job_list', raw: 'io error: Permission denied' })

        expect(error_shown(failure)).toBe(failure.friendly.message)
        expect(warn).not.toHaveBeenCalled()
    })
})
