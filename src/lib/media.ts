import { assert } from './assert'


export const AUDIO_EXTENSIONS = Object.freeze([
    'mp3',
    'wav',
    'm4a',
    'flac',
    'ogg',
    'oga',
    'aac',
    'mka',
])

export const VIDEO_EXTENSIONS = Object.freeze([
    'mp4',
    'm4v',
    'mkv',
    'mov',
    'webm',
    '3gp',
    '3g2',
])

export const MEDIA_EXTENSIONS = Object.freeze([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS])

export function path_is_media(path: string): boolean {
    assert(typeof path === 'string')
    assert(MEDIA_EXTENSIONS.length > 0)

    const dot = path.lastIndexOf('.')

    if (dot < 0) return false

    const extension = path.slice(dot + 1).toLowerCase()

    return MEDIA_EXTENSIONS.includes(extension)
}
