# Setup

## Overview

A first launch opens a welcome screen that creates your remi account. The account holds a balance of transcription hours, and each recording you transcribe draws on it.

## Create Your Account

1. Enter your name and your email.
2. Enter a promo code if you have one. A code adds free hours to the account.
3. Press *Get started*.

The balance shows in the sidebar. A transcription takes the length of its recording from the balance, rounded up to the second, and notes, rewrites, and questions take nothing.

## Buy Hours

1. Press *Buy hours* in the sidebar, or on the *Account* tab of Settings.
2. Pick a pack of hours.
3. Pay on the same page.

The hours land in your balance once the payment goes through. A purchase is a one-time payment, so nothing renews.

The *Promo code* box on the *Account* tab redeems a code later. Each code works once per email address, and an email address gets one offer from each event, whichever of the event's codes it uses.

## Sign In On Another Computer

1. Press *Copy sign-in code* on the *Account* tab of Settings, on a computer that is signed in.
2. Press *Have a sign-in code?* on the welcome screen of the other computer.
3. Paste the code and press *Sign in*.

The code opens your account, so keep it private, like a password.

## Use Your Company's Keys

A copy of remi built without keys asks for an API address and two keys instead, one for transcription and one for notes. Your company gives you all three.

1. Enter the *API address*, such as `https://api.example.com`.
2. Paste the *Transcription key* and the *Notes key*.
3. Press *Continue*.

The button tests nothing, so a wrong value only shows up at the first transcription. The *AI* tab of Settings changes any of the three later.

The keys are encrypted for your account on Windows, and on macOS and Linux they are plain text in a file only your account can read.

## What Leaves Your Computer

The audio and the names on your People page go to the transcription service. The transcript, the template, and the people you tick go to the notes service, which also handles corrections, rewrites, and titles. A question on the *Ask* page goes to the notes service with excerpts from the recordings that match it. Both services sit behind the one address.
