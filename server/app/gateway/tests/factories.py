from __future__ import annotations


FLAC_BLOCK_SAMPLES = 4096
FLAC_SAMPLE_RATE = 16_000
FLAC_STREAMINFO_BYTES = 34


def create_test_flac(
    *,
    bits: int = 16,
    body: bytes = b'',
    channels: int = 1,
    sample_count: int,
    sample_rate: int = FLAC_SAMPLE_RATE,
    stream_type: int = 0,
) -> bytes:
    assert 1 <= bits <= 1 << 5
    assert isinstance(body, bytes)
    assert 1 <= channels <= 1 << 3
    assert 0 <= sample_count < 1 << 36
    assert 0 <= sample_rate < 1 << 20
    assert 0 <= stream_type < 1 << 7

    fields = (
        (FLAC_BLOCK_SAMPLES, 16),
        (FLAC_BLOCK_SAMPLES, 16),
        (0, 24),
        (0, 24),
        (sample_rate, 20),
        (channels - 1, 3),
        (bits - 1, 5),
        (sample_count, 36),
        (0, 128),
    )

    packed = 0

    for value, width in fields:
        assert 0 <= value < 1 << width

        packed = packed << width | value

    header = bytes([0x80 | stream_type]) + FLAC_STREAMINFO_BYTES.to_bytes(3)

    return b'fLaC' + header + packed.to_bytes(FLAC_STREAMINFO_BYTES) + body
