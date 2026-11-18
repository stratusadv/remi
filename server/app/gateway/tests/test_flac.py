from __future__ import annotations

import random

import pytest

from app.core.exceptions import RequestInvalidError
from app.gateway.flac import FLAC_HEADER_BYTES, FlacStream, flac_milliseconds, flac_stream_read
from app.gateway.tests.factories import FLAC_BLOCK_SAMPLES, FLAC_SAMPLE_RATE, create_test_flac


SAMPLE_COUNT_MAX = (1 << 36) - 1
SEEDS = (1, 2, 3)


@pytest.mark.parametrize('seed', SEEDS)
def test_a_stream_reads_back_the_length_it_was_written_with(seed: int) -> None:
    assert seed in SEEDS

    generator = random.Random(seed)
    counts = [1, FLAC_BLOCK_SAMPLES, FLAC_SAMPLE_RATE * 120, SAMPLE_COUNT_MAX]

    counts.extend(generator.randrange(1, SAMPLE_COUNT_MAX) for _ in range(200))

    for count in counts:
        stream = flac_stream_read(create_test_flac(sample_count=count))

        assert stream == FlacStream(sample_count=count, sample_rate=FLAC_SAMPLE_RATE), count


@pytest.mark.parametrize('seed', SEEDS)
def test_milliseconds_are_the_least_that_cover_every_sample(seed: int) -> None:
    assert seed in SEEDS

    generator = random.Random(seed)

    for _ in range(500):
        count = generator.randrange(1, FLAC_SAMPLE_RATE * 600)
        stream = FlacStream(sample_count=count, sample_rate=FLAC_SAMPLE_RATE)
        milliseconds = flac_milliseconds(stream)

        assert milliseconds * FLAC_SAMPLE_RATE >= count * 1000, count
        assert (milliseconds - 1) * FLAC_SAMPLE_RATE < count * 1000, count


def test_whole_seconds_of_audio_count_exactly() -> None:
    for seconds in (1, 2, 5, 120):
        whole = FlacStream(sample_count=seconds * FLAC_SAMPLE_RATE, sample_rate=FLAC_SAMPLE_RATE)
        over = whole._replace(sample_count=whole.sample_count + 1)

        assert flac_milliseconds(whole) == seconds * 1000
        assert flac_milliseconds(over) == seconds * 1000 + 1


@pytest.mark.parametrize(
    'audio',
    [
        b'',
        b'fLaC',
        b'RIFF' + bytes(60),
        create_test_flac(sample_count=FLAC_SAMPLE_RATE, stream_type=1),
        create_test_flac(sample_count=FLAC_SAMPLE_RATE)[:41],
        create_test_flac(sample_count=FLAC_SAMPLE_RATE, sample_rate=44_100),
        create_test_flac(sample_count=FLAC_SAMPLE_RATE, channels=2),
        create_test_flac(sample_count=FLAC_SAMPLE_RATE, bits=24),
        create_test_flac(sample_count=0),
    ],
)
def test_audio_unlike_the_flac_remi_sends_is_refused(audio: bytes) -> None:
    assert audio != create_test_flac(sample_count=FLAC_SAMPLE_RATE)

    with pytest.raises(RequestInvalidError):
        flac_stream_read(audio)


def test_audio_longer_than_its_declared_length_is_refused() -> None:
    pcm_bytes = FLAC_SAMPLE_RATE * 2
    fitting = create_test_flac(body=bytes(pcm_bytes), sample_count=FLAC_SAMPLE_RATE)
    padded = create_test_flac(body=bytes(pcm_bytes * 2), sample_count=FLAC_SAMPLE_RATE)

    assert padded[:FLAC_HEADER_BYTES] == fitting[:FLAC_HEADER_BYTES]
    assert flac_stream_read(fitting).sample_count == FLAC_SAMPLE_RATE

    with pytest.raises(RequestInvalidError):
        flac_stream_read(padded)
