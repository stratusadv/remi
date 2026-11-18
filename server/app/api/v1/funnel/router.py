from ninja import Form, Router, Status

from django.http import HttpRequest

from app.api.v1.funnel.schemas import FunnelClickSchema, FunnelDownloadSchema, FunnelEmailSchema
from app.core.throttles import AddressRateThrottle
from app.funnel.mail import funnel_email_send
from app.funnel.metric import funnel_click_record, funnel_download_record
from app.funnel.promo import funnel_promo_downloaded


STATUS_NO_CONTENT = 204
THROTTLE_RATE_BEACON = '3000/m'
THROTTLE_RATE_EMAIL = '300/m'

router = Router(
    tags=['funnel'],
    throttle=[AddressRateThrottle(THROTTLE_RATE_BEACON, scope='funnel_beacon')],
)


@router.post('/click/', auth=None, response={STATUS_NO_CONTENT: None})
def funnel_click(request: HttpRequest, payload: Form[FunnelClickSchema]) -> Status:
    if not isinstance(payload, FunnelClickSchema):
        message = f'payload must be a FunnelClickSchema: {type(payload).__name__}'
        raise TypeError(message)

    _ = request

    funnel_click_record(campaign=payload.campaign, page=payload.page)

    return Status(STATUS_NO_CONTENT, None)


@router.post('/download/', auth=None, response={STATUS_NO_CONTENT: None})
def funnel_download(request: HttpRequest, payload: Form[FunnelDownloadSchema]) -> Status:
    if not isinstance(payload, FunnelDownloadSchema):
        message = f'payload must be a FunnelDownloadSchema: {type(payload).__name__}'
        raise TypeError(message)

    _ = request

    funnel_download_record(campaign=payload.campaign, platform=payload.platform)

    if payload.code != '':
        funnel_promo_downloaded(payload.code)

    return Status(STATUS_NO_CONTENT, None)


@router.post(
    '/email/',
    auth=None,
    response={STATUS_NO_CONTENT: None},
    throttle=AddressRateThrottle(THROTTLE_RATE_EMAIL, scope='funnel_email'),
)
def funnel_email(request: HttpRequest, payload: Form[FunnelEmailSchema]) -> Status:
    if not isinstance(payload, FunnelEmailSchema):
        message = f'payload must be a FunnelEmailSchema: {type(payload).__name__}'
        raise TypeError(message)

    _ = request

    funnel_email_send(
        address=payload.email,
        campaign=payload.campaign,
        name_first=payload.name_first,
        name_last=payload.name_last,
    )

    return Status(STATUS_NO_CONTENT, None)
