import { assert } from './assert'


export interface TraceSpan {
    duration_ms: number
    sample_rate: number
}

export const TRACE_HEIGHT = 200
export const TRACE_POINTS = 240
export const TRACE_WIDTH = 1440

const MILLISECONDS_PER_SECOND = 1000
const TRACE_AMPLITUDE = 85
const TRACE_BASELINE = 100
const TRACE_GAIN = 8
const TRACE_PRECISION = 100
const TRACE_RING_MS = 120
const TRACE_SAMPLE_RATE_MAX = 768_000
const TRACE_SEARCH_MS = 20
const TRACE_WINDOW_MS = 40


export function trace_crossing_upward(samples: Float32Array, index: number): boolean {
    assert(Number.isSafeInteger(index))
    assert(index >= 0)
    assert(index + 1 < samples.length)

    const before = samples[index] ?? 0
    const after = samples[index + 1] ?? 0

    if (before < 0) return after >= 0

    return false
}

export function trace_frames_for({ duration_ms, sample_rate }: TraceSpan): number {
    assert(Number.isSafeInteger(duration_ms))
    assert(duration_ms >= 0)
    assert(sample_rate > 0)
    assert(sample_rate <= TRACE_SAMPLE_RATE_MAX)

    return Math.floor((sample_rate * duration_ms) / MILLISECONDS_PER_SECOND)
}

export function trace_path(points: readonly number[]): string {
    assert(points.length <= TRACE_POINTS)
    assert(points.every((point) => point >= -1 && point <= 1))

    if (points.length < 2) return `M0 ${String(TRACE_BASELINE)}H${String(TRACE_WIDTH)}`

    const step = TRACE_WIDTH / (points.length - 1)

    return points
        .map((point, index) => {
            const point_x = (index * step).toFixed(1)
            const point_y = (TRACE_BASELINE - point * TRACE_AMPLITUDE).toFixed(1)

            return `${index === 0 ? 'M' : 'L'}${point_x} ${point_y}`
        })
        .join('')
}

export function trace_points(ordered: Float32Array, sample_rate: number): number[] {
    assert(ordered.length <= trace_ring_frames(TRACE_SAMPLE_RATE_MAX))
    assert(sample_rate > 0)

    const window = trace_frames_for({ duration_ms: TRACE_WINDOW_MS, sample_rate })
    const search = trace_frames_for({ duration_ms: TRACE_SEARCH_MS, sample_rate })
    const tail = ordered.subarray(Math.max(0, ordered.length - (window + search)))
    const trigger = trace_trigger(tail, search)
    const shown = tail.subarray(trigger, trigger + window)
    const points: number[] = []

    for (let index = 0; index < TRACE_POINTS; index += 1) {
        const start = Math.floor((index * shown.length) / TRACE_POINTS)
        const end = Math.max(start + 1, Math.floor(((index + 1) * shown.length) / TRACE_POINTS))
        const slice = shown.subarray(start, Math.min(end, shown.length))

        points.push(trace_level(slice))
    }

    assert(points.length === TRACE_POINTS)
    assert(points.every((point) => point >= -1 && point <= 1))

    return points
}

export function trace_ring_frames(sample_rate: number): number {
    assert(sample_rate > 0)
    assert(sample_rate <= TRACE_SAMPLE_RATE_MAX)

    const frames = trace_frames_for({ duration_ms: TRACE_RING_MS, sample_rate })

    assert(frames > 0)

    return frames
}

function trace_level(slice: Float32Array): number {
    assert(slice.length <= TRACE_SAMPLE_RATE_MAX)

    let sum = 0

    for (const sample of slice) {
        sum += sample
    }

    const level = Math.tanh((sum / Math.max(1, slice.length)) * TRACE_GAIN)
    const rounded = Number.isNaN(level) ? 0 : Math.round(level * TRACE_PRECISION) / TRACE_PRECISION

    assert(rounded >= -1)
    assert(rounded <= 1)

    return rounded
}

function trace_trigger(tail: Float32Array, search: number): number {
    assert(tail.length <= trace_ring_frames(TRACE_SAMPLE_RATE_MAX))
    assert(Number.isSafeInteger(search))
    assert(search >= 0)

    const limit = Math.min(search, tail.length - 1)
    let trigger = 0

    for (let index = 0; index < limit; index += 1) {
        if (trace_crossing_upward(tail, index)) {
            trigger = index + 1

            break
        }
    }

    assert(trigger <= search)
    assert(trigger < Math.max(1, tail.length))

    return trigger
}
