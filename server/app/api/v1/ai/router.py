from __future__ import annotations

import hashlib
import json

from typing_extensions import TYPE_CHECKING

from ninja import Router

from django.conf import settings

from app.core.exceptions import RequestInvalidError
from app.core.throttles import AccountRateThrottle
from app.gateway.client import chat_relay, embeddings_relay, multipart_encode, transcription_relay
from app.gateway.constants import (
    GATEWAY_AUDIO_BYTES_MAX,
    MODEL_CHAT,
    MODEL_CHAT_REASONING_EFFORT,
    MODEL_EMBEDDINGS,
    MODEL_TRANSCRIPTION,
)
from app.gateway.flac import flac_milliseconds, flac_stream_read

if TYPE_CHECKING:
    from ninja.throttling import BaseThrottle

    from django.http import HttpResponse, StreamingHttpResponse

    from app.api.auth import AccountRequest


DIGEST_BYTES = 16
HEADER_JOB_ID = 'Remi-Job-Id'

CHAT_THROTTLES: tuple[BaseThrottle, ...] = (
    AccountRateThrottle(f'{settings.REMI_CHAT_MINUTE_MAX}/m', scope='chat_minute'),
    AccountRateThrottle(f'{settings.REMI_CHAT_DAY_MAX}/d', scope='chat_day'),
)

EMBEDDINGS_THROTTLES: tuple[BaseThrottle, ...] = (
    AccountRateThrottle(f'{settings.REMI_EMBEDDINGS_MINUTE_MAX}/m', scope='embeddings_minute'),
    AccountRateThrottle(f'{settings.REMI_EMBEDDINGS_DAY_MAX}/d', scope='embeddings_day'),
)

router = Router(tags=['ai'])


def _chat_payload_read(request: AccountRequest) -> dict[str, object]:
    payload = _payload_read(request, model=MODEL_CHAT)
    thinking = {'enable_thinking': _chat_thinking(payload.get('reasoning_effort'))}

    return {**payload, 'chat_template_kwargs': thinking}


def _chat_thinking(effort: object) -> bool:
    if effort is None:
        return False

    if effort == MODEL_CHAT_REASONING_EFFORT:
        return True

    message = f'The AI service thinks at {MODEL_CHAT_REASONING_EFFORT} at most, not {effort!r}.'
    raise RequestInvalidError(message)


def _fields_read(request: AccountRequest) -> list[tuple[str, str]]:
    fields: list[tuple[str, str]] = []

    for name, values in request.POST.lists():
        value = values[-1] if values else ''

        if not isinstance(value, str):
            message = f'The {name} field must be text.'
            raise RequestInvalidError(message)

        fields.append((name, value))

    return fields


def _payload_read(request: AccountRequest, *, model: str) -> dict[str, object]:
    if model not in (MODEL_CHAT, MODEL_EMBEDDINGS):
        message = f'a JSON payload names the chat or the embeddings model, not {model!r}'
        raise ValueError(message)

    try:
        payload = json.loads(request.body)
    except (UnicodeDecodeError, ValueError):
        message = 'The request body is not JSON.'
        raise RequestInvalidError(message) from None

    if not isinstance(payload, dict):
        message = 'The request body must be a JSON object.'
        raise RequestInvalidError(message)

    requested = payload.get('model')

    if requested != model:
        message = f'The AI service runs {model} here, not {requested!r}. Pick the default model.'
        raise RequestInvalidError(message)

    return payload


@router.post('/v1/chat/completions', throttle=list(CHAT_THROTTLES))
def ai_chat(request: AccountRequest) -> HttpResponse | StreamingHttpResponse:
    payload = _chat_payload_read(request)

    request.auth.services.processor.gateway_authorize()

    return chat_relay(payload=payload)


@router.post('/v1/embeddings', throttle=list(EMBEDDINGS_THROTTLES))
def ai_embeddings(request: AccountRequest) -> HttpResponse:
    _ = _payload_read(request, model=MODEL_EMBEDDINGS)

    request.auth.services.processor.gateway_authorize()

    return embeddings_relay(body=request.body)


@router.get('/v1/models')
def ai_models(request: AccountRequest) -> dict[str, object]:
    if request.auth.pk is None:
        message = f'the authenticated account must be saved: {request.auth!r}'
        raise ValueError(message)

    model = {'id': MODEL_CHAT, 'object': 'model', 'owned_by': 'remi'}

    return {'data': [model], 'object': 'list'}


@router.post('/v1/audio/transcriptions')
def ai_transcription(request: AccountRequest) -> HttpResponse:
    upload = request.FILES.get('file')

    if upload is None:
        message = 'The request has no audio file.'
        raise RequestInvalidError(message)

    if upload.size is None:
        message = f'A piece of audio must be under {GATEWAY_AUDIO_BYTES_MAX} bytes.'
        raise RequestInvalidError(message)

    if upload.size > GATEWAY_AUDIO_BYTES_MAX:
        message = f'A piece of audio must be under {GATEWAY_AUDIO_BYTES_MAX} bytes.'
        raise RequestInvalidError(message)

    model = request.POST.get('model', '')

    if model != MODEL_TRANSCRIPTION:
        message = f'The AI service transcribes with {MODEL_TRANSCRIPTION}, not {model!r}.'
        raise RequestInvalidError(message)

    audio = upload.read()
    stream = flac_stream_read(audio)
    digest = hashlib.blake2b(audio, digest_size=DIGEST_BYTES).hexdigest()

    request.auth.services.processor.transcription_reserve(
        digest=digest,
        job_id=request.headers.get(HEADER_JOB_ID, ''),
        milliseconds=flac_milliseconds(stream),
    )

    fields = _fields_read(request)
    body, content_type = multipart_encode(audio=audio, fields=fields)

    return transcription_relay(body=body, content_type=content_type)
