# Setup

## Overview

scribe needs an API address and two keys, one for transcription and one for notes. Your company gives you all three.

## Add Your Keys

A first launch opens a welcome screen.

1. Enter the *API address*, such as `https://api.example.com`.
2. Paste the *Transcription key* and the *Notes key*.
3. Press *Continue*.

The button tests nothing, so a wrong value only shows up at the first transcription. The *AI* tab of Settings changes any of the three later.

The keys are encrypted for your account on Windows, and on Linux they are plain text in a file only your account can read.

## What Leaves Your Computer

The audio and the names on your People page go to the transcription service. The transcript, the template, and the people you tick go to the notes service, which also handles corrections, rewrites, and titles. Both services sit behind the one address.
