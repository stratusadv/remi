import { documentDir, homeDir, join } from '@tauri-apps/api/path'
import { assert } from './assert'


const ELLIPSIS = '…'
const EXTENSION_SUFFIX = /\.[^.]+$/
const FILE_NAME_CHARS_KEPT = 57
const FILE_NAME_CHARS_MAX = 60
const PATH_SEPARATORS = /[\\/]/


export async function folder_start(): Promise<string> {
    const folder = await documentDir().catch(async () => homeDir())

    assert(typeof folder === 'string')
    assert(folder.length > 0)

    return folder
}

export function path_file_name(path: string): string {
    assert(typeof path === 'string')

    const name = path.split(PATH_SEPARATORS).pop() ?? path

    assert(name.length <= path.length)

    return name
}

export function path_file_name_short(path: string): string {
    assert(typeof path === 'string')
    assert(ELLIPSIS.length === 1)

    const name = path_file_name(path)

    if (name.length <= FILE_NAME_CHARS_MAX) return name

    return name.slice(0, FILE_NAME_CHARS_KEPT) + ELLIPSIS
}

export function path_file_stem(path: string): string {
    assert(typeof path === 'string')

    const stem = path_file_name(path).replace(EXTENSION_SUFFIX, '')

    assert(stem.length <= path.length)

    return stem
}

export async function path_in_folder_start(name: string): Promise<string> {
    assert(typeof name === 'string')
    assert(name.length > 0)

    return folder_start().then(async (folder) => join(folder, name))
}
