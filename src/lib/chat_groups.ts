import { assert } from './assert'
import type { ChatSummary } from '../types'


export interface ChatGroup {
    label: string
    chats: ChatSummary[]
}

interface ChatPeriod {
    label: string
    days_back: number
}

const CHATS_MAX = 1000
const LABEL_OLDER = 'Older'

const PERIODS: readonly ChatPeriod[] = Object.freeze([
    { label: 'Today', days_back: 0 },
    { label: 'Yesterday', days_back: 1 },
    { label: 'Previous 7 days', days_back: 7 },
    { label: 'Previous 30 days', days_back: 30 },
])


export function chats_grouped(chats: readonly ChatSummary[], now_ms: number): ChatGroup[] {
    assert(chats.length <= CHATS_MAX)
    assert(Number.isFinite(now_ms))

    const now = new Date(now_ms)

    const starts = PERIODS.map((period) => new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - period.days_back,
    ).getTime())

    const newest_first = [...chats].sort((left, right) => (
        right.updated_at_unix_ms - left.updated_at_unix_ms
    ))

    const groups: ChatGroup[] = []

    for (const chat of newest_first) {
        const index = starts.findIndex((start) => chat.updated_at_unix_ms >= start)
        const label = PERIODS[index]?.label ?? LABEL_OLDER
        const last = groups.at(-1)

        if (last?.label === label) {
            last.chats.push(chat)

            continue
        }

        groups.push({ label, chats: [chat] })
    }

    assert(groups.length <= PERIODS.length + 1)

    return groups
}
