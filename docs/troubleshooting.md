# Troubleshooting

## Overview

These are the messages you are most likely to see.

| Message | Fix |
|---------|-----|
| `401 chat completion: ...` | The server no longer accepts this copy's sign-in, so restart remi and sign in again on the welcome screen. |
| `... This account has no hours left. ...` | The notes, *Ask*, search, and titles all need hours left, so buy more on the *Account* tab of Settings. |
| `... for 30 days after each recording it processes. ...` | The account has not transcribed a recording in the last 30 days, so transcribe one to use them again. |
| `... Too many requests. Try again in a minute. (throttled)` | The account sent more requests than remi allows in a minute or a day, so wait and try again. |
| `the part at ... did not come back after ...: ...` | A part failed and the run stopped, so press *Transcribe* to try again. A `401` there means the server no longer accepts this copy's sign-in. |
| `no suitable format reader found` | The app cannot read the file, so [convert it](recording.md#files-that-open). |
| `unsupported audio codec` | The app cannot read the audio inside the file, so [convert it](recording.md#files-that-open). |
| `no speech came back for this recording, so no transcript was saved` | The recording is silent, or the service returned no text for it. |
| `target path must end with .docx or .md` | Name the file with one of those extensions. |
