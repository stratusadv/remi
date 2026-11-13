import { assert } from './assert'


const MILLISECONDS_PER_SECOND = 1000
export const SECONDS_PER_HOUR = 3600
const SECONDS_PER_MINUTE = 60
const TENTHS_PER_UNIT = 10


export function seconds_to_balance(seconds: number): string {
    assert(typeof seconds === 'number')

    const whole = seconds_valid(seconds) ? Math.floor(seconds) : 0

    if (whole < SECONDS_PER_HOUR) {
        const minutes = Math.floor(whole / SECONDS_PER_MINUTE)

        return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`
    }

    const tenths = Math.floor((whole * TENTHS_PER_UNIT) / SECONDS_PER_HOUR)

    assert(tenths >= TENTHS_PER_UNIT)
    assert(tenths * SECONDS_PER_HOUR <= whole * TENTHS_PER_UNIT)

    if (tenths === TENTHS_PER_UNIT) return '1 hour'

    return `${String(tenths / TENTHS_PER_UNIT)} hours`
}

export function seconds_to_clock(seconds: number): string {
    assert(typeof seconds === 'number')

    if (!seconds_valid(seconds)) return '0:00'

    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
    const seconds_rest = Math.floor(seconds % SECONDS_PER_MINUTE)

    assert(minutes >= 0)
    assert(seconds_rest < SECONDS_PER_MINUTE)

    return `${String(minutes)}:${String(seconds_rest).padStart(2, '0')}`
}

export function seconds_to_clock_hours(seconds: number): string {
    assert(typeof seconds === 'number')

    if (!seconds_valid(seconds)) return '0:00'

    const hours = Math.floor(seconds / SECONDS_PER_HOUR)
    const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
    const seconds_rest = Math.floor(seconds % SECONDS_PER_MINUTE)
    const minutes_text = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
    const minutes_seconds = `${minutes_text}:${String(seconds_rest).padStart(2, '0')}`

    assert(hours >= 0)
    assert(minutes < SECONDS_PER_MINUTE)

    return hours > 0 ? `${String(hours)}:${minutes_seconds}` : minutes_seconds
}

export function unix_now(): number {
    const now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND)

    assert(now >= 0, 'the clock reads a time before the epoch')
    assert(Number.isSafeInteger(now))

    return now
}

function seconds_valid(seconds: number): boolean {
    assert(typeof seconds === 'number')

    return Number.isFinite(seconds) && seconds >= 0
}
