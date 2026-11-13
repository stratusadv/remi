import { describe, expect, it, vi } from 'vitest'
import { documentDir, homeDir, join } from '@tauri-apps/api/path'
import {
    folder_start,
    path_file_name,
    path_file_name_short,
    path_file_stem,
    path_in_folder_start,
} from '../../src/lib/paths'


vi.mock('@tauri-apps/api/path')


describe('path_file_name', () => {
    it('returns the last segment of a posix path', () => {
        expect(path_file_name('/home/you/recordings/weekly-sync.m4a')).toBe('weekly-sync.m4a')
    })

    it('returns the last segment of a windows path', () => {
        expect(path_file_name('C:\\Users\\you\\Music\\Recording.wav')).toBe('Recording.wav')
    })

    it('returns a bare name unchanged', () => {
        expect(path_file_name('notes.md')).toBe('notes.md')
    })

    it('returns an empty string for a trailing separator', () => {
        expect(path_file_name('/home/you/')).toBe('')
    })
})

describe('path_file_name_short', () => {
    it('keeps a name of sixty characters or fewer intact', () => {
        const name = `${'a'.repeat(56)}.mp3`

        expect(path_file_name_short(`/tmp/${name}`)).toBe(name)
    })

    it('truncates a long name to fifty-seven characters plus an ellipsis', () => {
        const name = `${'b'.repeat(80)}.wav`
        const short = path_file_name_short(`/tmp/${name}`)

        expect(short).toBe(`${'b'.repeat(57)}…`)
        expect(short.length).toBe(58)
    })
})

describe('path_file_stem', () => {
    it('strips the extension from the file name', () => {
        expect(path_file_stem('/home/you/recordings/weekly-sync.m4a')).toBe('weekly-sync')
    })

    it('strips only the final extension', () => {
        expect(path_file_stem('archive.tar.gz')).toBe('archive.tar')
    })

    it('leaves a name without an extension alone', () => {
        expect(path_file_stem('/var/log/syslog')).toBe('syslog')
    })
})

describe('folder_start', () => {
    it('starts a dialog in Documents, never in the working directory', async () => {
        vi.mocked(documentDir).mockResolvedValue('/home/you/Documents')
        vi.mocked(join).mockImplementation(async (...parts) => Promise.resolve(parts.join('/')))

        const folder = await folder_start()
        const path = await path_in_folder_start('notes.docx')

        expect(folder).toBe('/home/you/Documents')
        expect(path).toBe('/home/you/Documents/notes.docx')
    })

    it('falls back to home on a system with no Documents folder', async () => {
        vi.mocked(documentDir).mockRejectedValue(new Error('unknown path'))
        vi.mocked(homeDir).mockResolvedValue('/home/you')

        const folder = await folder_start()

        expect(folder).toBe('/home/you')
    })
})
