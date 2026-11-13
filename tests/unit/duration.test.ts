import { describe, expect, it } from 'vitest'
import { assert } from '../../src/lib/assert'
import {
    seconds_to_balance,
    seconds_to_clock,
    seconds_to_clock_hours,
} from '../../src/lib/duration'


const BALANCE_PATTERN = /^(?<whole>\d+)(?:\.(?<tenth>\d))? (?<unit>hours?|minutes?)$/
const BALANCE_SAMPLES = 2000
const BALANCE_SECONDS_MAX = 2_000_000
const BALANCE_TENTHS_SWEPT = 5000
const SECONDS_PER_HOUR_TENTH = 360
const SECONDS_PER_MINUTE = 60
const TENTHS_PER_HOUR = 10

interface BalanceShown {
    seconds: number
    step_seconds: number
}

function balance_shown(text: string): BalanceShown {
    assert(text.length > 0)

    const groups = BALANCE_PATTERN.exec(text)?.groups
    const whole = groups?.['whole']
    const unit = groups?.['unit']

    assert(whole !== undefined, `unreadable balance ${text}`)
    assert(unit !== undefined, `unreadable balance ${text}`)

    if (unit.startsWith('minute')) {
        return { seconds: Number(whole) * SECONDS_PER_MINUTE, step_seconds: SECONDS_PER_MINUTE }
    }

    const tenths = Number(whole) * TENTHS_PER_HOUR + Number(groups?.['tenth'] ?? '0')

    return { seconds: tenths * SECONDS_PER_HOUR_TENTH, step_seconds: SECONDS_PER_HOUR_TENTH }
}

describe('seconds_to_balance', () => {
    it('reads minutes under an hour and tenths of an hour above it', () => {
        expect(seconds_to_balance(0)).toBe('0 minutes')
        expect(seconds_to_balance(59)).toBe('0 minutes')
        expect(seconds_to_balance(60)).toBe('1 minute')
        expect(seconds_to_balance(3599)).toBe('59 minutes')
        expect(seconds_to_balance(3600)).toBe('1 hour')
        expect(seconds_to_balance(5400)).toBe('1.5 hours')
        expect(seconds_to_balance(899_999)).toBe('249.9 hours')
        expect(seconds_to_balance(900_000)).toBe('250 hours')
    })

    it('falls back to zero for invalid input', () => {
        expect(seconds_to_balance(-1)).toBe('0 minutes')
        expect(seconds_to_balance(Number.NaN)).toBe('0 minutes')
    })

    it('shows each tenth of an hour exactly at its boundary and one second before it', () => {
        for (let tenths = 11; tenths <= BALANCE_TENTHS_SWEPT; tenths += 1) {
            const boundary = tenths * SECONDS_PER_HOUR_TENTH

            expect(balance_shown(seconds_to_balance(boundary)).seconds).toBe(boundary)

            expect(balance_shown(seconds_to_balance(boundary - 1)).seconds)
                .toBe(boundary - SECONDS_PER_HOUR_TENTH)
        }
    })

    it('never shows more than the balance and never less by a whole step', () => {
        let state = 7

        for (let sample = 0; sample < BALANCE_SAMPLES; sample += 1) {
            state = (state * 48_271) % 2_147_483_647

            const seconds = state % BALANCE_SECONDS_MAX
            const shown = balance_shown(seconds_to_balance(seconds))

            expect(shown.seconds).toBeLessThanOrEqual(seconds)
            expect(seconds - shown.seconds).toBeLessThan(shown.step_seconds)
        }
    })
})

describe('seconds_to_clock', () => {
    it('formats minutes and zero-padded seconds', () => {
        expect(seconds_to_clock(0)).toBe('0:00')
        expect(seconds_to_clock(65)).toBe('1:05')
        expect(seconds_to_clock(3599.9)).toBe('59:59')
    })

    it('falls back to zero for invalid input', () => {
        expect(seconds_to_clock(-1)).toBe('0:00')
        expect(seconds_to_clock(Number.NaN)).toBe('0:00')
        expect(seconds_to_clock(Number.POSITIVE_INFINITY)).toBe('0:00')
    })
})

describe('seconds_to_clock_hours', () => {
    it('adds an hours field only past one hour', () => {
        expect(seconds_to_clock_hours(59)).toBe('0:59')
        expect(seconds_to_clock_hours(3600)).toBe('1:00:00')
        expect(seconds_to_clock_hours(4023)).toBe('1:07:03')
    })
})
