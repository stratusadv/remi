import { assert } from './assert'
import { hash_fnv } from './hash'


export const MONOGRAM_HUE_COUNT = 4
const MONOGRAM_LETTERS_MAX = 2


export function monogram_hue(text: string): number {
    assert(typeof text === 'string')

    const hue = hash_fnv(text.trim().toLowerCase()) % MONOGRAM_HUE_COUNT

    assert(Number.isInteger(hue))
    assert(hue >= 0)
    assert(hue < MONOGRAM_HUE_COUNT)

    return hue
}

function monogram_initial(word: string): string {
    assert(word.length > 0)

    const first = Array.from(word)[0] ?? ''
    const upper = Array.from(first.toLocaleUpperCase())[0] ?? ''

    assert(Array.from(upper).length === 1)

    return upper
}

export function monogram_letters(text: string): string {
    assert(typeof text === 'string')

    const words = text.trim().split(/\s+/u).filter((word) => word.length > 0)

    const letters = words
        .slice(0, MONOGRAM_LETTERS_MAX)
        .map(monogram_initial)
        .join('')

    assert(Array.from(letters).length <= MONOGRAM_LETTERS_MAX)

    return letters
}
