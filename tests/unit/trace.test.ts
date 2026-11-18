import { describe, expect, it } from 'vitest'
import { AssertionError, assert } from '../../src/lib/assert'
import {
    TRACE_POINTS,
    TRACE_WIDTH,
    trace_crossing_upward,
    trace_frames_for,
    trace_path,
    trace_points,
    trace_ring_frames,
} from '../../src/lib/trace'


const AMPLITUDE = 85
const BASELINE = 100
const PATH_COMMAND = /[ML](?<x>[\d.]+) (?<y>-?[\d.]+)/gu
const RATE = 16_000
const READ_ERROR_MAX = 0.0006
const RING_SAMPLES = 1920


interface Point {
    left: number
    top: number
}

interface Wave {
    amplitude: number
    frequency: number
    phase: number
}

function increasing(values: readonly number[]): boolean {
    assert(values.length >= 2)
    assert(values.every((value) => Number.isFinite(value)))

    return values.slice(1).every((value, index) => value > (values[index] ?? Infinity))
}

function path_points(path: string): Point[] {
    assert(path.startsWith('M'))

    const points = [...path.matchAll(PATH_COMMAND)].map((match) => ({
        left: Number(match.groups?.['x']),
        top: Number(match.groups?.['y']),
    }))

    assert(points.length > 0)

    return points
}

function peak(points: readonly number[]): number {
    assert(points.length === TRACE_POINTS)
    assert(points.every((point) => Number.isFinite(point)))

    return Math.max(...points.map((point) => Math.abs(point)))
}

function points_filled(value: number): number[] {
    assert(value >= -1)
    assert(value <= 1)

    return Array.from({ length: TRACE_POINTS }, () => value)
}

function sine(wave: Wave, count: number): Float32Array {
    assert(wave.frequency > 0)
    assert(Number.isSafeInteger(count))

    const step = (2 * Math.PI * wave.frequency) / RATE
    const angles = [...Array(count).keys()].map((index) => wave.phase + index * step)
    const samples = angles.map((angle) => Math.sin(angle) * wave.amplitude)

    return Float32Array.from(samples)
}

describe('trace_points', () => {
    it('draws silence as a flat line across every point', () => {
        const points = trace_points(new Float32Array(RING_SAMPLES), RATE)

        expect(points).toEqual(points_filled(0))
    })

    it('draws a steady level as tanh of eight times it, to the hundredth', () => {
        const above = trace_points(new Float32Array(RING_SAMPLES).fill(0.05), RATE)
        const below = trace_points(new Float32Array(RING_SAMPLES).fill(-0.05), RATE)

        expect(above).toEqual(points_filled(0.38))
        expect(below).toEqual(points_filled(-0.38))
    })

    it('starts the window at the first rise through zero', () => {
        const signal = new Float32Array(960)

        signal.fill(-0.1, 0, 100)
        signal.fill(0.1, 100)

        expect(trace_points(signal, RATE)).toEqual(points_filled(0.66))
    })

    it('draws in time order from where the search began when nothing rises through zero', () => {
        const signal = new Float32Array(960)

        signal.fill(0.1, 0, 320)
        signal.fill(-0.1, 320)

        const points = trace_points(signal, RATE)

        expect(points.slice(0, 120)).toEqual(points_filled(0.66).slice(0, 120))
        expect(points.slice(120)).toEqual(points_filled(-0.66).slice(120))
    })

    it('draws the same tone the same way whatever its phase', () => {
        const wave = { amplitude: 0.2, frequency: 200, phase: 0 }
        const early = trace_points(sine(wave, RING_SAMPLES), RATE)
        const late = trace_points(sine({ ...wave, phase: 2.1 }, RING_SAMPLES), RATE)
        const drift = Math.max(...early.map((point, index) => Math.abs(point - (late[index] ?? 0))))

        expect(drift).toBeLessThanOrEqual(0.1)
        expect(early[0]).toBeGreaterThanOrEqual(0)
        expect(increasing(early.slice(0, 4))).toBe(true)
    })

    it('keeps a loud signal inside the scale and still shows a quiet one', () => {
        const wave = { amplitude: 1, frequency: 150, phase: 0 }
        const loud = trace_points(sine(wave, RING_SAMPLES), RATE)
        const quiet = trace_points(sine({ ...wave, amplitude: 0.02 }, RING_SAMPLES), RATE)

        expect(peak(loud)).toBeLessThanOrEqual(1)
        expect(peak(quiet)).toBeGreaterThanOrEqual(0.08)
    })

    it('yields every point from a short buffer and from one that is not a number', () => {
        const short = trace_points(Float32Array.from([0.1, -0.1, 0.1]), RATE)
        const broken = trace_points(new Float32Array(64).fill(Number.NaN), RATE)
        const endless = trace_points(new Float32Array(64).fill(Number.POSITIVE_INFINITY), RATE)

        expect(short).toEqual(points_filled(0.66))
        expect(broken).toEqual(points_filled(0))
        expect(endless).toEqual(points_filled(1))
    })
})

describe('trace_crossing_upward, trace_frames_for, and trace_ring_frames', () => {
    it('counts only a rise from below zero to zero or above', () => {
        expect(trace_crossing_upward(Float32Array.from([-1, 1]), 0)).toBe(true)
        expect(trace_crossing_upward(Float32Array.from([-0.1, 0.1]), 0)).toBe(true)
        expect(trace_crossing_upward(Float32Array.from([-0.1, 0]), 0)).toBe(true)
        expect(trace_crossing_upward(Float32Array.from([0.1, -0.1]), 0)).toBe(false)
        expect(trace_crossing_upward(Float32Array.from([0, 0.1]), 0)).toBe(false)
        expect(trace_crossing_upward(Float32Array.from([-0.2, -0.1]), 0)).toBe(false)
        expect(trace_crossing_upward(Float32Array.from([0.1, -0.1, 0.1]), 1)).toBe(true)
        expect(() => trace_crossing_upward(Float32Array.from([-1, 1]), 1)).toThrow(AssertionError)
    })

    it('rounds a span down to whole samples', () => {
        expect(trace_frames_for({ duration_ms: 40, sample_rate: 16_000 })).toBe(640)
        expect(trace_frames_for({ duration_ms: 20, sample_rate: 44_100 })).toBe(882)
        expect(trace_frames_for({ duration_ms: 120, sample_rate: 48_000 })).toBe(5760)
        expect(trace_frames_for({ duration_ms: 1, sample_rate: 44_100 })).toBe(44)
    })

    it('keeps 120 ms of samples and refuses a rate with no whole sample in that time', () => {
        expect(trace_ring_frames(RATE)).toBe(RING_SAMPLES)
        expect(trace_ring_frames(44_100)).toBe(5292)
        expect(() => trace_ring_frames(8)).toThrow(AssertionError)
    })
})

describe('trace_path', () => {
    it('draws a flat baseline before there are points', () => {
        expect(trace_path([])).toBe(`M0 ${String(BASELINE)}H${String(TRACE_WIDTH)}`)
    })

    it('spans the full width and reads back the points it was given', () => {
        const points = [...Array(TRACE_POINTS).keys()].map((index) =>
            Math.round(Math.sin(index / 9) * 100) / 100)

        const drawn = path_points(trace_path(points))
        const read = drawn.map((point) => (BASELINE - point.top) / AMPLITUDE)
        const errors = read.map((value, index) => Math.abs(value - (points[index] ?? 0)))

        expect(drawn).toHaveLength(TRACE_POINTS)
        expect(drawn[0]?.left).toBe(0)
        expect(drawn.at(-1)?.left).toBe(TRACE_WIDTH)
        expect(increasing(drawn.map((point) => point.left))).toBe(true)
        expect(Math.max(...errors)).toBeLessThanOrEqual(READ_ERROR_MAX)
    })
})
