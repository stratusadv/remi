import { assert } from './assert'


const FNV_OFFSET = 2166136261
const FNV_PRIME = 16777619
const UINT32_LIMIT = 2 ** 32


export function hash_fnv(text: string): number {
    assert(typeof text === 'string')

    let hash = FNV_OFFSET

    for (const char of text) {
        hash ^= char.codePointAt(0) ?? 0
        hash = Math.imul(hash, FNV_PRIME) >>> 0
    }

    assert(Number.isInteger(hash))
    assert(hash >= 0)
    assert(hash < UINT32_LIMIT)

    return hash
}
