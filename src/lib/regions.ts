import { assert } from './assert'
import type { RegionCode } from '../types'


export const REGIONS_CANADA: Readonly<Record<RegionCode, string>> = Object.freeze({
    'CA-AB': 'Alberta',
    'CA-BC': 'British Columbia',
    'CA-MB': 'Manitoba',
    'CA-NB': 'New Brunswick',
    'CA-NL': 'Newfoundland and Labrador',
    'CA-NT': 'Northwest Territories',
    'CA-NS': 'Nova Scotia',
    'CA-NU': 'Nunavut',
    'CA-ON': 'Ontario',
    'CA-PE': 'Prince Edward Island',
    'CA-QC': 'Quebec',
    'CA-SK': 'Saskatchewan',
    'CA-YT': 'Yukon',
})


export function region_is_known(code: string): boolean {
    assert(typeof code === 'string')

    const known = Object.hasOwn(REGIONS_CANADA, code)

    if (known) assert(code === code.trim())

    return known
}
