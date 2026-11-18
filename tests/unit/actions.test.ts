import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { action_report } from '../../src/lib/actions'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { log_warn } from '../../src/lib/log'
import { deferred_new } from './fixtures'
import type { AccountAction } from '../../src/types'


vi.mock('../../src/lib/ipc')
vi.mock('../../src/lib/log')

const ACTION_BACKEND_PATH = resolve(import.meta.dirname, '../../src-tauri/src/account.rs')
const ACTION_BACKEND_PATTERN = /pub\(crate\) enum AccountAction \{(?<body>[^}]+)\}/u
const ACTION_SERVER_PATH = resolve(import.meta.dirname, '../../server/app/funnel/metric.py')
const ACTION_SERVER_PATTERN = /METRIC_ACTIONS_REPORTED = frozenset\(\{(?<body>[^}]+)\}\)/u
const CHOICE_PATTERN = /^ {4}(?<member>[A-Z_]+) = '(?<value>[a-z-]+)', '[^']+'$/gmu
const MEMBER_PATTERN = /MetricAction\.(?<member>[A-Z_]+)/gu
const VARIANT_PATTERN = /^ {4}(?<variant>[A-Z][A-Za-z]+),$/gmu
const WORD_BOUNDARY_PATTERN = /(?<=[a-z])(?=[A-Z])/gu

const ACTIONS_FRONTEND = Object.freeze<Record<AccountAction, true>>({
    'ask-folder-question': true,
    'ask-library-question': true,
    'ask-note-question': true,
    'change-theme': true,
    'in-app-recording': true,
    'new-chat': true,
    'new-folder-created': true,
    'new-template': true,
    'upload-recording': true,
})


function actions_backend(): string[] {
    const source = readFileSync(ACTION_BACKEND_PATH, 'utf8')
    const body = ACTION_BACKEND_PATTERN.exec(source)?.groups?.['body']

    assert(body !== undefined, 'account.rs declares no AccountAction')

    const matches = Array.from(body.matchAll(VARIANT_PATTERN))

    assert(matches.length > 0)

    return matches.map((match) => {
        const variant = match.groups?.['variant']

        assert(variant !== undefined)

        return variant.replace(WORD_BOUNDARY_PATTERN, '-').toLowerCase()
    })
}

function actions_server(): string[] {
    const source = readFileSync(ACTION_SERVER_PATH, 'utf8')
    const body = ACTION_SERVER_PATTERN.exec(source)?.groups?.['body']
    const values = new Map<string, string>()

    assert(body !== undefined, 'metric.py declares no METRIC_ACTIONS_REPORTED')

    for (const match of source.matchAll(CHOICE_PATTERN)) {
        const member = match.groups?.['member']
        const value = match.groups?.['value']

        assert(member !== undefined)
        assert(value !== undefined)

        values.set(member, value)
    }

    return Array.from(body.matchAll(MEMBER_PATTERN), (match) => {
        const member = match.groups?.['member']

        assert(member !== undefined)

        const value = values.get(member)

        assert(value !== undefined, `metric.py gives MetricAction.${member} no value`)

        return value
    })
}

function names_sorted(names: string[]): string[] {
    assert(names.length > 0)
    assert(names.every((name) => name.length > 0))

    return [...names].sort((left, right) => left.localeCompare(right))
}

beforeEach(() => {
    vi.resetAllMocks()
})

describe('account actions', () => {
    it('are the nine the backend sends and the server records, by the same names', () => {
        const frontend = names_sorted(Object.keys(ACTIONS_FRONTEND))

        expect(names_sorted(actions_backend())).toEqual(frontend)
        expect(names_sorted(actions_server())).toEqual(frontend)
        expect(frontend).toHaveLength(9)
    })
})

describe('action_report', () => {
    it('sends the action once without waiting for the reply', async () => {
        vi.mocked(ipc.account_action_report).mockReturnValue(deferred_new<undefined>().promise)

        action_report('new-chat')
        await flushPromises()

        expect(ipc.account_action_report).toHaveBeenCalledTimes(1)
        expect(ipc.account_action_report).toHaveBeenCalledWith('new-chat')
    })

    it('logs a report that failed and never passes the failure on', async () => {
        const failure = new Error('api error: 503 action report: down')

        vi.mocked(ipc.account_action_report).mockRejectedValue(failure)

        action_report('change-theme')
        await flushPromises()

        expect(log_warn).toHaveBeenCalledWith('[action] not reported', 'change-theme', failure)
    })

    it('logs a report that threw before it was sent and never passes the throw on', async () => {
        const failure = new Error('assertion failed')

        vi.mocked(ipc.account_action_report).mockImplementation(() => {
            throw failure
        })

        expect(() => {
            action_report('new-template')
        }).not.toThrow()

        await flushPromises()

        expect(log_warn).toHaveBeenCalledWith('[action] not reported', 'new-template', failure)
    })
})
