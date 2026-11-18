from __future__ import annotations

from typing_extensions import NamedTuple

from app.account.constants import MILLISECONDS_PER_SECOND
from app.core.exceptions import RequestInvalidError


FLAC_BITS_PER_BYTE = 8
FLAC_BLOCK_TYPE_MASK = 0x7F
FLAC_BLOCK_TYPE_STREAMINFO = 0
FLAC_FORMAT = (16_000, 1, 16)
FLAC_HEADER_BYTES = 42
FLAC_MARKER = b'fLaC'
FLAC_OVERHEAD_BYTES = 4_096
FLAC_STREAMINFO_BYTES = 34
FLAC_STREAMINFO_OFFSET = 8


class FlacStream(NamedTuple):
    sample_count: int
    sample_rate: int


def flac_milliseconds(stream: FlacStream) -> int:
    if stream.sample_count <= 0:
        message = f'a stream must hold samples: {stream.sample_count}'
        raise ValueError(message)

    if stream.sample_rate <= 0:
        message = f'a stream must run at a positive rate: {stream.sample_rate}'
        raise ValueError(message)

    milliseconds = -(-stream.sample_count * MILLISECONDS_PER_SECOND // stream.sample_rate)

    if milliseconds * stream.sample_rate < stream.sample_count * MILLISECONDS_PER_SECOND:
        message = f'{stream} rounded down to {milliseconds} ms'
        raise RuntimeError(message)

    return milliseconds


def flac_stream_read(audio: bytes) -> FlacStream:
    if len(audio) < FLAC_HEADER_BYTES:
        message = 'The audio is too short to be a FLAC stream.'
        raise RequestInvalidError(message)

    if audio[:len(FLAC_MARKER)] != FLAC_MARKER:
        message = 'The audio is not a FLAC stream.'
        raise RequestInvalidError(message)

    block_type = audio[len(FLAC_MARKER)] & FLAC_BLOCK_TYPE_MASK
    block_length = int.from_bytes(audio[len(FLAC_MARKER) + 1:FLAC_STREAMINFO_OFFSET])

    if (block_type, block_length) != (FLAC_BLOCK_TYPE_STREAMINFO, FLAC_STREAMINFO_BYTES):
        message = 'The audio does not open with a FLAC STREAMINFO block.'
        raise RequestInvalidError(message)

    streaminfo = audio[FLAC_STREAMINFO_OFFSET:FLAC_HEADER_BYTES]
    sample_rate = streaminfo[10] << 12 | streaminfo[11] << 4 | streaminfo[12] >> 4
    channels = (streaminfo[12] >> 1 & 0x07) + 1
    bits_per_sample = ((streaminfo[12] & 0x01) << 4 | streaminfo[13] >> 4) + 1
    sample_count = (streaminfo[13] & 0x0F) << 32 | int.from_bytes(streaminfo[14:18])

    if (sample_rate, channels, bits_per_sample) != FLAC_FORMAT:
        message = (
            f'The audio must be {FLAC_FORMAT[0]} Hz mono {FLAC_FORMAT[2]}-bit FLAC, not '
            f'{sample_rate} Hz with {channels} channels at {bits_per_sample} bits.'
        )

        raise RequestInvalidError(message)

    if sample_count == 0:
        message = 'The audio declares no samples.'
        raise RequestInvalidError(message)

    pcm_bytes = sample_count * channels * bits_per_sample // FLAC_BITS_PER_BYTE
    audio_bytes_max = pcm_bytes + pcm_bytes // 32 + FLAC_OVERHEAD_BYTES

    if len(audio) > audio_bytes_max:
        message = 'The audio holds more data than its declared length.'
        raise RequestInvalidError(message)

    return FlacStream(sample_count=sample_count, sample_rate=sample_rate)
