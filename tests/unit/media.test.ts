import { describe, expect, it } from 'vitest'
import {
    AUDIO_EXTENSIONS,
    MEDIA_EXTENSIONS,
    VIDEO_EXTENSIONS,
    path_is_media,
} from '../../src/lib/media'


describe('MEDIA_EXTENSIONS', () => {
    it('is the audio list followed by the video list', () => {
        expect(MEDIA_EXTENSIONS).toEqual([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS])
    })

    it('holds no duplicates', () => {
        expect(new Set(MEDIA_EXTENSIONS).size).toBe(MEDIA_EXTENSIONS.length)
    })

    it('is frozen', () => {
        expect(Object.isFrozen(MEDIA_EXTENSIONS)).toBe(true)
        expect(Object.isFrozen(AUDIO_EXTENSIONS)).toBe(true)
        expect(Object.isFrozen(VIDEO_EXTENSIONS)).toBe(true)
    })
})

describe('path_is_media', () => {
    it('rejects each format the decoder refused in a real run', () => {
        const refused = [
            'ac3',
            'aif',
            'aiff',
            'amr',
            'avi',
            'caf',
            'flv',
            'm2ts',
            'mpeg',
            'mpg',
            'mts',
            'opus',
            'spx',
            'ts',
            'vob',
            'wma',
            'wmv',
        ]

        for (const extension of refused) {
            expect(path_is_media(`/tmp/clip.${extension}`)).toBe(false)
        }
    })

    it('accepts every listed audio and video extension', () => {
        for (const extension of MEDIA_EXTENSIONS) {
            expect(path_is_media(`/tmp/clip.${extension}`)).toBe(true)
        }
    })

    it('ignores extension case', () => {
        expect(path_is_media('C:\\Music\\Recording.WAV')).toBe(true)
        expect(path_is_media('meeting.Mp4')).toBe(true)
    })

    it('rejects a path without an extension', () => {
        expect(path_is_media('/tmp/recording')).toBe(false)
    })

    it('rejects an unknown extension', () => {
        expect(path_is_media('/tmp/notes.txt')).toBe(false)
        expect(path_is_media('/tmp/notes.md')).toBe(false)
        expect(path_is_media('/tmp/image.png')).toBe(false)
    })

    it('uses only the final extension', () => {
        expect(path_is_media('/tmp/clip.mp3.txt')).toBe(false)
        expect(path_is_media('/tmp/clip.txt.mp3')).toBe(true)
    })

    it('treats a dot in a directory name as an extension boundary', () => {
        expect(path_is_media('/tmp/some.dir/clip')).toBe(false)
    })
})
