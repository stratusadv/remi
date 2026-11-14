from __future__ import annotations

from typing_extensions import TYPE_CHECKING

from ninja import NinjaAPI
from ninja.errors import AuthenticationError, HttpError, Throttled, ValidationError
from ninja.throttling import AnonRateThrottle, AuthRateThrottle

from app.account.constants import SIGNED_OUT_MESSAGE
from app.api.auth import AccountBearerAuth
from app.core.exceptions import BillingError

if TYPE_CHECKING:
    from django.http import HttpRequest, HttpResponse


ERROR_TYPE = 'billing_error'
LOCATION_CONTAINERS = ('body', 'form', 'payload', 'query')
STATUS_BAD_REQUEST = 400
STATUS_ERROR_MAX = 599
STATUS_THROTTLED = 429
THROTTLE_RATE_ANONYMOUS = '600/m'
THROTTLE_RATE_AUTHENTICATED = '1200/m'

api_v1 = NinjaAPI(
    auth=AccountBearerAuth(),
    openapi_url=None,
    throttle=[
        AnonRateThrottle(THROTTLE_RATE_ANONYMOUS),
        AuthRateThrottle(THROTTLE_RATE_AUTHENTICATED),
    ],
    title='remi API',
    urls_namespace='api_v1',
    version='1.0.0',
)

api_v1.add_router('/account/', 'app.api.v1.account.router.router')
api_v1.add_router('/funnel/', 'app.api.v1.funnel.router.router')


def error_response(
    request: HttpRequest,
    *,
    code: str,
    message: str,
    status: int,
) -> HttpResponse:
    if code == '':
        message_invalid = 'code must be non-empty'
        raise ValueError(message_invalid)

    if message == '':
        message_invalid = f'the {code} error must carry a message'
        raise ValueError(message_invalid)

    if not STATUS_BAD_REQUEST <= status <= STATUS_ERROR_MAX:
        message_invalid = f'status must be an error status: {status}'
        raise ValueError(message_invalid)

    detail = {'code': code, 'message': message, 'type': ERROR_TYPE}
    payload = {'error': detail}

    return api_v1.create_response(request, payload, status=status)


def validation_message(errors: list[dict[str, object]]) -> str:
    if not errors:
        message = 'errors must be non-empty'
        raise ValueError(message)

    error = errors[0]
    location = error.get('loc', ())

    if not isinstance(location, tuple):
        message = f'a validation error carries a location of {type(location).__name__}'
        raise TypeError(message)

    names = [part for part in location if isinstance(part, str)]
    fields = [name for name in names if name not in LOCATION_CONTAINERS]

    if not fields:
        return 'The request body must be a JSON object.'

    field = fields[-1]

    if error.get('type') == 'missing':
        return f'The request has no {field}.'

    return f'The request needs a valid {field}.'


@api_v1.exception_handler(AuthenticationError)
def authentication_error_handle(request: HttpRequest, error: AuthenticationError) -> HttpResponse:
    if not isinstance(error, AuthenticationError):
        message = f'error must be an AuthenticationError: {type(error).__name__}'
        raise TypeError(message)

    return error_response(request, code='token_invalid', message=SIGNED_OUT_MESSAGE, status=401)


@api_v1.exception_handler(BillingError)
def billing_error_handle(request: HttpRequest, error: BillingError) -> HttpResponse:
    if not isinstance(error, BillingError):
        message = f'error must be a BillingError: {type(error).__name__}'
        raise TypeError(message)

    return error_response(request, code=error.code, message=str(error), status=error.status)


@api_v1.exception_handler(HttpError)
def http_error_handle(request: HttpRequest, error: HttpError) -> HttpResponse:
    if not isinstance(error, HttpError):
        message = f'error must be an HttpError: {type(error).__name__}'
        raise TypeError(message)

    if error.status_code == STATUS_BAD_REQUEST:
        message = 'The request body is not JSON.'
        return error_response(request, code='request_invalid', message=message, status=400)

    return error_response(
        request,
        code='request_refused',
        message=str(error),
        status=error.status_code,
    )


@api_v1.exception_handler(Throttled)
def throttled_handle(request: HttpRequest, error: Throttled) -> HttpResponse:
    if not isinstance(error, Throttled):
        message = f'error must be Throttled: {type(error).__name__}'
        raise TypeError(message)

    message = 'Too many requests. Try again in a minute.'

    return error_response(request, code='throttled', message=message, status=STATUS_THROTTLED)


@api_v1.exception_handler(ValidationError)
def validation_error_handle(request: HttpRequest, error: ValidationError) -> HttpResponse:
    if not isinstance(error, ValidationError):
        message = f'error must be a ValidationError: {type(error).__name__}'
        raise TypeError(message)

    message = validation_message(error.errors)

    return error_response(request, code='request_invalid', message=message, status=400)
