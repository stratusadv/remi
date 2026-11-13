import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assert } from '../../src/lib/assert'
import { chats_grouped } from '../../src/lib/chat_groups'
import type { ChatSummary } from '../../src/types'


type GroupTitles = [string, string[]]

const HOUR_MS = 3_600_000
const TIME_ZONE = 'America/Edmonton'
const time_zone_before = process.env['TZ']


function chat_at(title: string, at: Date): ChatSummary {
    assert(title.length > 0)
    assert(Number.isFinite(at.getTime()))

    return { id: crypto.randomUUID(), title, updated_at_unix_ms: at.getTime() }
}

function titles_grouped(chats: readonly ChatSummary[], now: Date): GroupTitles[] {
    assert(chats.length > 0)
    assert(Number.isFinite(now.getTime()))

    return chats_grouped(chats, now.getTime()).map((group) => [
        group.label,
        group.chats.map((chat) => chat.title),
    ])
}

beforeAll(() => {
    process.env['TZ'] = TIME_ZONE
})

afterAll(() => {
    if (time_zone_before === undefined) {
        delete process.env['TZ']

        return
    }

    process.env['TZ'] = time_zone_before
})

describe('chats_grouped', () => {
    it('files each chat under the calendar day it was last used, newest first', () => {
        const now = new Date(2026, 10, 11, 9, 30)

        const chats = [
            chat_at('older', new Date(2026, 9, 11, 23, 59)),
            chat_at('a week ago', new Date(2026, 10, 4, 0, 0)),
            chat_at('midnight', new Date(2026, 10, 11, 0, 0)),
            chat_at('last night', new Date(2026, 10, 10, 23, 59)),
            chat_at('a month ago', new Date(2026, 9, 12, 0, 0)),
            chat_at('this morning', new Date(2026, 10, 11, 8, 0)),
            chat_at('just over a week', new Date(2026, 10, 3, 23, 59)),
            chat_at('clock ahead', new Date(2026, 10, 11, 10, 30)),
            chat_at('two days ago', new Date(2026, 10, 9, 12, 0)),
        ]

        expect(titles_grouped(chats, now)).toEqual([
            ['Today', ['clock ahead', 'this morning', 'midnight']],
            ['Yesterday', ['last night']],
            ['Previous 7 days', ['two days ago', 'a week ago']],
            ['Previous 30 days', ['just over a week', 'a month ago']],
            ['Older', ['older']],
        ])

        expect(chats_grouped([], now.getTime())).toEqual([])
    })

    it('counts the 25 hour day the clocks fall back as one day', () => {
        const now = new Date(2025, 10, 3, 0, 30)
        const yesterday = new Date(2025, 10, 2, 0, 30)
        const chats = [chat_at('before the change', yesterday)]

        expect(now.getTime() - yesterday.getTime()).toBe(25 * HOUR_MS)
        expect(titles_grouped(chats, now)).toEqual([['Yesterday', ['before the change']]])
    })

    it('counts the 23 hour day the clocks spring forward as one day', () => {
        const now = new Date(2026, 2, 9, 0, 30)
        const yesterday = new Date(2026, 2, 8, 0, 30)

        const chats = [
            chat_at('before the change', yesterday),
            chat_at('the night before', new Date(2026, 2, 7, 23, 30)),
        ]

        expect(now.getTime() - yesterday.getTime()).toBe(23 * HOUR_MS)

        expect(titles_grouped(chats, now)).toEqual([
            ['Yesterday', ['before the change']],
            ['Previous 7 days', ['the night before']],
        ])
    })
})
