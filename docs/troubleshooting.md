# Troubleshooting

## Overview

These are the messages you are most likely to see.

| Message | Fix |
|---------|-----|
| `No API address has been set. Enter one under Settings, AI.` | Enter the address on the *AI* tab of Settings. |
| `The API address ... is not a valid web address (...).` | Add `https://` to the address. |
| `401 chat completion: ...` | The service refused the notes key, so replace it on the *AI* tab of Settings. |
| `the part at ... did not come back after ...: ...` | A part failed and the run stopped, so press *Transcribe* to try again. A `401` there means a wrong transcription key. |
| `no suitable format reader found` | The app cannot read the file, so [convert it](recording.md#files-that-open). |
| `unsupported audio codec` | The app cannot read the audio inside the file, so [convert it](recording.md#files-that-open). |
| `no speech came back for this recording, so no transcript was saved` | The recording is silent, or the service returned no text for it. |
| `target path must end with .docx or .md` | Name the file with one of those extensions. |
