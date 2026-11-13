import { describe, expect, it } from 'vitest'
import { assert } from '../../src/lib/assert'
import { citations_split } from '../../src/lib/citations'


const FRAGMENTS = Object.freeze([
    'Hannah agreed',
    ' to renew ',
    '[M1]',
    '[M2]',
    '[M9]',
    '[M]',
    '[m1]',
    '[[M1]]',
    '. ',
    '',
    '\n',
])

const FRAGMENTS_GROUPED = Object.freeze([
    'Hannah agreed',
    '[M1, M2]',
    '[M2,M3]',
    '[M1, M9]',
    '[M1,',
    ' M2]',
    ', ',
    'M3',
    ']',
    '[',
    '. ',
])

function answer_generate(seed: number, fragments: readonly string[] = FRAGMENTS): string {
    assert(Number.isInteger(seed))
    assert(seed > 0)
    assert(fragments.length > 0)

    let state = seed
    let answer = ''

    for (let index = 0; index < 12; index += 1) {
        state = (state * 48271) % 2147483647
        answer += fragments[state % fragments.length] ?? ''
    }

    return answer
}

describe('citations_split', () => {
    it('turns known markers into citations and leaves the rest as text', () => {
        const parts = citations_split('Yes [M1], and later [M3].', ['M1', 'M2'])

        expect(parts).toEqual([
            { text: 'Yes ', marker: null },
            { text: '[M1]', marker: 'M1' },
            { text: ', and later ', marker: null },
            { text: '[M3]', marker: null },
            { text: '.', marker: null },
        ])
    })

    it('splits adjacent citations and keeps an answer without any whole', () => {
        expect(citations_split('[M1][M2]', ['M1', 'M2']).map((part) => part.marker))
            .toEqual(['M1', 'M2'])

        expect(citations_split('Nothing found.', ['M1'])).toEqual([
            { text: 'Nothing found.', marker: null },
        ])

        expect(citations_split('', ['M1'])).toEqual([])
    })

    it('rebuilds every answer exactly from its parts', () => {
        for (let seed = 1; seed <= 300; seed += 1) {
            const answer = answer_generate(seed)
            const parts = citations_split(answer, ['M1', 'M2'])
            const cited = parts.filter((part) => part.marker !== null)

            expect(parts.map((part) => part.text).join('')).toBe(answer)
            expect(cited.every((part) => part.text === `[${part.marker ?? ''}]`)).toBe(true)
            expect(parts.every((part) => part.text.length > 0)).toBe(true)
        }
    })

    it('gives each marker in a grouped citation its own part', () => {
        const parts = citations_split('Both [M1, M3] and [M2,M9].', ['M1', 'M2', 'M3'])

        expect(parts).toEqual([
            { text: 'Both ', marker: null },
            { text: '[M1, ', marker: 'M1' },
            { text: 'M3]', marker: 'M3' },
            { text: ' and ', marker: null },
            { text: '[M2,', marker: 'M2' },
            { text: 'M9]', marker: null },
            { text: '.', marker: null },
        ])
    })

    it('leaves a group longer than eight markers as text', () => {
        const answer = '[M1, M2, M3, M4, M5, M6, M7, M8, M9]'

        expect(citations_split(answer, ['M1'])).toEqual([{ text: answer, marker: null }])
        expect(citations_split(answer.replace(', M9', ''), ['M1'])[0]?.marker).toBe('M1')
    })

    it('rebuilds every grouped answer and cites only markers it names', () => {
        for (let seed = 1; seed <= 300; seed += 1) {
            const answer = answer_generate(seed, FRAGMENTS_GROUPED)
            const parts = citations_split(answer, ['M1', 'M2', 'M3'])
            const cited = parts.filter((part) => part.marker !== null)

            expect(parts.map((part) => part.text).join('')).toBe(answer)
            expect(cited.every((part) => /M\d+/.exec(part.text)?.[0] === part.marker)).toBe(true)
            expect(cited.every((part) => part.marker !== 'M9')).toBe(true)
            expect(parts.every((part) => part.text.length > 0)).toBe(true)
        }
    })
})
