from __future__ import annotations

import random
import threading

import pytest

from functools import partial, partialmethod
from typing_extensions import TYPE_CHECKING

from django.db import connection

from app.account.constants import (
    MILLISECONDS_PER_SECOND,
    SECONDS_PER_HOUR,
    TRANSCRIPTION_CHUNK_MILLISECONDS_MAX,
    TRANSCRIPTION_PADDING_MILLISECONDS,
)
from app.account.tests.factories import create_test_account
from app.account.transcription.models import AccountTranscriptionChunk
from app.account.transcription.services.factory_service import (
    AccountTranscriptionChunkFactoryService,
)
from app.core.exceptions import RequestInvalidError, TranscriptionUnpaidError

if TYPE_CHECKING:
    from collections.abc import Callable

    from app.account.models import Account


JOB_ID = '86dfb1d3b0140ecf2fd59075421f1cb5'
JOB_ID_OTHER = '47ead100cc5cd956aa10b3c4d5e6f708'
LOCK_HOLD_SECONDS = 1.0
MILLISECONDS_CHOICES = (1, 999, 2_000, 5_000, 30_000, 61_000)
SECONDS_CHARGED = 60
SEEDS = (1, 2, 3, 4)
THREAD_WAIT_SECONDS = 10.0

MILLISECONDS_ALLOWED = (
    SECONDS_CHARGED * MILLISECONDS_PER_SECOND + TRANSCRIPTION_PADDING_MILLISECONDS
)


def _account_charged(*, email: str = 'avery@example.com') -> Account:
    assert '@' in email

    account = create_test_account(email=email, seconds=SECONDS_PER_HOUR)

    account.services.processor.charge(job_id=JOB_ID, seconds=SECONDS_CHARGED)

    return account


def _create_pausing(
    service: AccountTranscriptionChunkFactoryService,
    *,
    created_first: threading.Event,
    done_second: threading.Event,
    create: Callable[..., AccountTranscriptionChunk],
    **fields: object,
) -> AccountTranscriptionChunk:
    assert service.model_obj_is_new
    assert not created_first.is_set()
    assert not done_second.is_set()

    chunk = create(service, **fields)

    if threading.current_thread().name == 'first':
        created_first.set()
        waited = done_second.wait(timeout=LOCK_HOLD_SECONDS)

        assert not waited

    return chunk


def _digest(index: int) -> str:
    assert index >= 0

    return f'{index:032x}'


def _reserve_thread(
    account: Account,
    *,
    done_second: threading.Event,
    outcomes: dict[str, bool],
) -> None:
    name = threading.current_thread().name

    assert name in ('first', 'second')
    assert name not in outcomes
    assert not done_second.is_set()

    try:
        digest = _digest(1) if name == 'first' else _digest(2)

        account.services.processor.transcription_reserve(
            digest=digest,
            job_id=JOB_ID,
            milliseconds=SECONDS_CHARGED * MILLISECONDS_PER_SECOND,
        )
    except TranscriptionUnpaidError:
        outcomes[name] = False
    else:
        outcomes[name] = True
    finally:
        if name == 'second':
            done_second.set()

        connection.close()


@pytest.mark.django_db
def test_a_recording_never_charged_transcribes_nothing() -> None:
    account = create_test_account(seconds=SECONDS_PER_HOUR)

    assert not account.ledger_entries.charges().by_reference(JOB_ID).exists()

    with pytest.raises(TranscriptionUnpaidError):
        account.services.processor.transcription_reserve(
            digest=_digest(1),
            job_id=JOB_ID,
            milliseconds=1_000,
        )

    assert AccountTranscriptionChunk.objects.count() == 0


@pytest.mark.django_db
def test_a_charged_recording_takes_its_length_and_one_padded_piece_and_no_more() -> None:
    account = _account_charged()
    processor = account.services.processor

    processor.transcription_reserve(digest=_digest(1), job_id=JOB_ID, milliseconds=30_000)
    processor.transcription_reserve(digest=_digest(2), job_id=JOB_ID, milliseconds=30_000)

    processor.transcription_reserve(
        digest=_digest(3),
        job_id=JOB_ID,
        milliseconds=TRANSCRIPTION_PADDING_MILLISECONDS,
    )

    with pytest.raises(TranscriptionUnpaidError):
        processor.transcription_reserve(digest=_digest(4), job_id=JOB_ID, milliseconds=1)

    total = account.transcription_chunks.by_job(JOB_ID).milliseconds_total()

    assert total == MILLISECONDS_ALLOWED
    assert AccountTranscriptionChunk.objects.count() == 3


@pytest.mark.django_db
def test_a_piece_sent_again_counts_once() -> None:
    account = _account_charged()
    processor = account.services.processor

    for _ in range(3):
        processor.transcription_reserve(digest=_digest(1), job_id=JOB_ID, milliseconds=60_000)

    assert AccountTranscriptionChunk.objects.count() == 1
    assert account.transcription_chunks.milliseconds_total() == 60_000


@pytest.mark.django_db
def test_each_account_and_recording_keeps_its_own_allowance() -> None:
    first = _account_charged()
    second = _account_charged(email='blake@example.com')

    first.services.processor.charge(job_id=JOB_ID_OTHER, seconds=SECONDS_CHARGED)

    for account in (first, second):
        account.services.processor.transcription_reserve(
            digest=_digest(1),
            job_id=JOB_ID,
            milliseconds=60_000,
        )

    first.services.processor.transcription_reserve(
        digest=_digest(1),
        job_id=JOB_ID_OTHER,
        milliseconds=60_000,
    )

    assert first.transcription_chunks.by_job(JOB_ID).milliseconds_total() == 60_000
    assert first.transcription_chunks.by_job(JOB_ID_OTHER).milliseconds_total() == 60_000
    assert second.transcription_chunks.milliseconds_total() == 60_000


@pytest.mark.django_db
@pytest.mark.parametrize(
    ('job_id', 'milliseconds'),
    [
        ('', 1_000),
        ('86DFB1D3B0140ECF2FD59075421F1CB5', 1_000),
        (JOB_ID, 0),
        (JOB_ID, TRANSCRIPTION_CHUNK_MILLISECONDS_MAX + 1),
    ],
)
def test_a_malformed_recording_or_length_is_refused(job_id: str, milliseconds: int) -> None:
    assert len(job_id) in (0, len(JOB_ID))
    assert 0 <= milliseconds <= TRANSCRIPTION_CHUNK_MILLISECONDS_MAX + 1

    account = _account_charged()

    assert account.ledger_entries.charges().by_reference(JOB_ID).exists()

    with pytest.raises(RequestInvalidError):
        account.services.processor.transcription_reserve(
            digest=_digest(1),
            job_id=job_id,
            milliseconds=milliseconds,
        )

    assert AccountTranscriptionChunk.objects.count() == 0


@pytest.mark.django_db
@pytest.mark.parametrize('seed', SEEDS)
def test_reserved_audio_matches_a_reference_and_never_passes_the_charge(seed: int) -> None:
    assert seed in SEEDS

    generator = random.Random(seed)
    account = _account_charged()
    processor = account.services.processor
    reserved: dict[str, int] = {}

    for _ in range(200):
        digest = _digest(generator.randrange(40))
        milliseconds = reserved.get(digest, generator.choice(MILLISECONDS_CHOICES))

        if digest in reserved:
            processor.transcription_reserve(digest=digest, job_id=JOB_ID, milliseconds=milliseconds)
        elif sum(reserved.values()) + milliseconds <= MILLISECONDS_ALLOWED:
            processor.transcription_reserve(digest=digest, job_id=JOB_ID, milliseconds=milliseconds)
            reserved[digest] = milliseconds
        else:
            with pytest.raises(TranscriptionUnpaidError):
                processor.transcription_reserve(
                    digest=digest,
                    job_id=JOB_ID,
                    milliseconds=milliseconds,
                )

    total = account.transcription_chunks.milliseconds_total()

    assert total == sum(reserved.values())
    assert total <= MILLISECONDS_ALLOWED
    assert AccountTranscriptionChunk.objects.count() == len(reserved)


@pytest.mark.django_db(transaction=True)
def test_two_pieces_racing_for_the_last_of_a_charge_admit_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account = _account_charged()
    created_first = threading.Event()
    done_second = threading.Event()
    outcomes: dict[str, bool] = {}
    create_original = AccountTranscriptionChunkFactoryService.create

    create_pausing = partialmethod(
        _create_pausing,
        created_first=created_first,
        done_second=done_second,
        create=create_original,
    )

    reserve = partial(_reserve_thread, account, done_second=done_second, outcomes=outcomes)

    monkeypatch.setattr(AccountTranscriptionChunkFactoryService, 'create', create_pausing)

    first = threading.Thread(target=reserve, name='first')
    second = threading.Thread(target=reserve, name='second')

    first.start()

    waited = created_first.wait(timeout=THREAD_WAIT_SECONDS)

    assert waited

    second.start()
    first.join(timeout=THREAD_WAIT_SECONDS)
    second.join(timeout=THREAD_WAIT_SECONDS)
    monkeypatch.undo()

    assert outcomes == {'first': True, 'second': False}
    assert AccountTranscriptionChunk.objects.count() == 1
