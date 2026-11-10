# Recording

## Overview

A recording starts as a file or a microphone capture. The app turns it into lines you can check before any notes are written.

## Transcribe A Recording

1. Press *New recording* on Home.
2. Drop a file onto the window, or press *Record with the microphone* and then *Stop recording* when you finish.
3. Press *Transcribe*.
4. Check the lines, then press *Next*.

A drop of two or more files transcribes them one after another. Press *Paste a transcript* in step 2 to use a transcript made elsewhere, and enter its title on the Meeting step.

!!! warning "Stop Before Six Hours"
    A capture keeps nothing after 6 hours, and the timer keeps running. Stop a long capture and start a new one before then.

## Files That Open

A file can run 6 hours and has to be one of these.

| Extension | Result |
|-----------|--------|
| `.wav`, `.mp3`, `.flac`, `.aac` | The file opens. |
| `.m4a` | The file opens with AAC audio. |
| `.ogg`, `.oga`, `.webm` | The file opens with Vorbis audio. |
| `.mp4`, `.m4v`, `.mov`, `.3gp`, `.3g2` | The file opens with AAC audio. |
| `.mkv`, `.mka` | The file opens with AAC, Vorbis, or FLAC audio. |

Convert any other file to FLAC with a tool such as [FFmpeg](https://ffmpeg.org): `ffmpeg -i meeting.opus -vn meeting.flac`.

## Fix The Transcript

Press the pencil to correct one line. Enter an instruction such as `it is Riley Chen, not Riley Chan` in the box under the list and press *Apply* to fix a name throughout. A change does not reach notes already written, so press *Regenerate notes* to carry it over.

## If An Upload Fails

Press *Transcribe* to try again. The parts that came back are not kept, so the upload starts again from the first part.

## Where Recordings Live

Each recording keeps its transcript, its notes, and a copy of its audio in `~/.local/share/com.stratusadv.scribe` on Linux and `%APPDATA%\com.stratusadv.scribe` on Windows. A microphone capture also stays in `scribe` inside your Music folder, unless you pick another in Settings.

The *Delete* item on Home removes a recording's folder and cannot be undone. The original file stays where it is.
