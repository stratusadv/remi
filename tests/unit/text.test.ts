import { describe, expect, it } from 'vitest'
import { assert } from '../../src/lib/assert'
import { text_truncate } from '../../src/lib/text'


const TEXT_MIXED = 'a\u{20BB7}bc\u{1F399}\u{1F399}d'


function prefix_longest(text: string, length_max: number): string {
    assert(typeof text === 'string')
    assert(Number.isSafeInteger(length_max))
    assert(length_max >= 0)

    const characters = Array.from(text)
    let prefix = ''

    for (const character of characters) {
        if (prefix.length + character.length > length_max) break

        prefix += character
    }

    return prefix
}

describe('text_truncate', () => {
    it('returns text within the limit unchanged', () => {
        expect(text_truncate(TEXT_MIXED, TEXT_MIXED.length)).toBe(TEXT_MIXED)
        expect(text_truncate(TEXT_MIXED, TEXT_MIXED.length + 1)).toBe(TEXT_MIXED)
        expect(text_truncate('', 0)).toBe('')
    })

    it('keeps the longest prefix of whole characters at every limit', () => {
        for (let length_max = 0; length_max <= TEXT_MIXED.length; length_max += 1) {
            const truncated = text_truncate(TEXT_MIXED, length_max)

            expect(truncated).toBe(prefix_longest(TEXT_MIXED, length_max))
            expect(new TextDecoder().decode(new TextEncoder().encode(truncated))).toBe(truncated)
        }
    })
})
