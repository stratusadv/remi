import { describe, expect, it } from 'vitest'
import { AssertionError, assert } from '../../src/lib/assert'


describe('assert', () => {
    it('returns without throwing when the condition holds', () => {
        expect(() => {
            assert(Number.isInteger(1), 'never raised')
        }).not.toThrow()
    })

    it('throws an AssertionError carrying the message when the condition fails', () => {
        expect(() => {
            assert(Number.isNaN(1), 'the waveform has too many bars')
        }).toThrow(new AssertionError('the waveform has too many bars'))
    })
})
