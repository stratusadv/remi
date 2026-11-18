import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assert } from '../../src/lib/assert'
import {
    REGIONS_CANADA,
    REGIONS_UNITED_STATES,
    REGION_OUTSIDE,
    REGION_OUTSIDE_NAME,
    region_is_known,
} from '../../src/lib/regions'


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
    '__proto__',
    'ca-ab',
    'constructor',
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
    it('offers the regions the server accepts, in its order and under its names', () => {
        const offered = [
            ...Object.entries(REGIONS_CANADA),
            ...Object.entries(REGIONS_UNITED_STATES),
            [REGION_OUTSIDE, REGION_OUTSIDE_NAME],
        ]

        expect(offered).toEqual(server_regions())
    })

    it('knows each region it offers and nothing else', () => {
        const codes = server_regions().map(([code]) => code)

        expect(codes.filter((code) => !region_is_known(code))).toEqual([])
        expect(REGIONS_UNKNOWN.filter((code) => region_is_known(code))).toEqual([])
    })
})
