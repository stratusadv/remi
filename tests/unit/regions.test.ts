import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assert } from '../../src/lib/assert'
import { REGIONS_CANADA, region_is_known } from '../../src/lib/regions'


const CHOICE_PATTERN = /^ {4}[A-Z_]+ = '(?<code>[^']+)', '(?<name>[^']+)'$/gmu
const CHOICES_PATH = resolve(import.meta.dirname, '../../server/app/account/choices.py')

const REGIONS_UNKNOWN = Object.freeze([
    '',
    ' CA-AB',
    'AB',
    'Alberta',
    'CA-AB ',
    'CA-XX',
    'OUTSIDE',
    'US-DC',
    'US-NY',
    '__proto__',
    'ca-ab',
    'constructor',
    'outside',
    'toString',
])


function server_regions(): (readonly [string, string])[] {
    const source = readFileSync(CHOICES_PATH, 'utf8')

    const regions = Array.from(source.matchAll(CHOICE_PATTERN), (match) => {
        const code = match.groups?.['code']
        const name = match.groups?.['name']

        assert(code !== undefined)
        assert(name !== undefined)

        return [code, name] as const
    })

    assert(regions.length > 0)

    return regions
}

describe('regions', () => {
    it('offers the provinces and territories the server knows, in its order and names', () => {
        const canada = server_regions().filter(([code]) => code.startsWith('CA-'))

        expect(Object.entries(REGIONS_CANADA)).toEqual(canada)
        expect(canada).toHaveLength(13)
    })

    it('knows each province and territory and no region outside Canada', () => {
        const codes = server_regions().map(([code]) => code)
        const outside = codes.filter((code) => !code.startsWith('CA-'))

        expect(codes.filter((code) => code.startsWith('CA-') && !region_is_known(code))).toEqual([])
        expect(outside.length).toBeGreaterThan(0)
        expect(outside.filter((code) => region_is_known(code))).toEqual([])
        expect(REGIONS_UNKNOWN.filter((code) => region_is_known(code))).toEqual([])
    })
})
