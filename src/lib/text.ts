import { assert } from './assert'


export const SURROGATE_HIGH_TRAILING = /[\uD800-\uDBFF]$/u


export function text_truncate(text: string, length_max: number): string {
    assert(typeof text === 'string')
    assert(Number.isSafeInteger(length_max))
    assert(length_max >= 0)

    if (text.length <= length_max) return text

    const truncated = text.slice(0, length_max).replace(SURROGATE_HIGH_TRAILING, '')

    assert(truncated.length <= length_max)

    return truncated
}
