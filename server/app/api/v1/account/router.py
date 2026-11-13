from ninja import Router, Status

from django.http import HttpRequest
from django.urls import reverse

from app.account.models import Account
from app.api.auth import AccountRequest
from app.api.v1.account.schemas import (
    AccountChargeSchema,
    AccountCreatedSchema,
    AccountCreateSchema,
    AccountPromoSchema,
    AccountSchema,
    CheckoutFinishedSchema,
    CheckoutFinishSchema,
    CheckoutSchema,
    CheckoutStartSchema,
    QuestionFinishedSchema,
    QuestionFinishSchema,
    QuestionStartedSchema,
)


STATUS_CREATED = 201

router = Router(tags=['account'])


@router.post('/', auth=None, response={STATUS_CREATED: AccountCreatedSchema})
def account_create(request: HttpRequest, payload: AccountCreateSchema) -> Status:
    if not isinstance(payload, AccountCreateSchema):
        message = f'payload must be an AccountCreateSchema: {type(payload).__name__}'
        raise TypeError(message)

    _ = request

    account, token = Account.services.factory.create(
        email=payload.email,
        name=payload.name,
        promo_code=payload.promo_code,
    )

    created = {'account': account, 'token': token}

    return Status(STATUS_CREATED, created)


@router.get('/', response=AccountSchema)
def account_detail(request: AccountRequest) -> Account:
    if request.auth.pk is None:
        message = f'the authenticated account must be saved: {request.auth!r}'
        raise ValueError(message)

    return request.auth


@router.post('/charge/', response=AccountSchema)
def account_charge(request: AccountRequest, payload: AccountChargeSchema) -> Account:
    if not isinstance(payload, AccountChargeSchema):
        message = f'payload must be an AccountChargeSchema: {type(payload).__name__}'
        raise TypeError(message)

    request.auth.services.processor.charge(job_id=payload.job_id, seconds=payload.seconds)

    return request.auth


@router.post('/checkout/', response=CheckoutSchema)
def account_checkout(request: AccountRequest, payload: CheckoutStartSchema) -> dict[str, object]:
    if not isinstance(payload, CheckoutStartSchema):
        message = f'payload must be a CheckoutStartSchema: {type(payload).__name__}'
        raise TypeError(message)

    checkout = request.auth.services.checkout
    return_url = request.build_absolute_uri(reverse('checkout:return'))
    session = checkout.session_create(hours=payload.hours, return_url=return_url)

    return {'client_secret': session.client_secret, 'session_id': session.id}


@router.post('/checkout/finish/', response=CheckoutFinishedSchema)
def account_checkout_finish(
    request: AccountRequest,
    payload: CheckoutFinishSchema,
) -> dict[str, object]:
    if not isinstance(payload, CheckoutFinishSchema):
        message = f'payload must be a CheckoutFinishSchema: {type(payload).__name__}'
        raise TypeError(message)

    paid = request.auth.services.checkout.session_finish(payload.session_id)

    return {'account': request.auth, 'paid': paid}


@router.post('/promo/', response=AccountSchema)
def account_promo(request: AccountRequest, payload: AccountPromoSchema) -> Account:
    if not isinstance(payload, AccountPromoSchema):
        message = f'payload must be an AccountPromoSchema: {type(payload).__name__}'
        raise TypeError(message)

    return request.auth.services.processor.promo_redeem(payload.code)


@router.post('/question/', response=QuestionStartedSchema)
def account_question_start(request: AccountRequest) -> dict[str, object]:
    if request.auth.pk is None:
        message = f'the authenticated account must be saved: {request.auth!r}'
        raise ValueError(message)

    question, pace = request.auth.services.processor.question_start()
    question_id = None if question is None else question.pk

    return {'notice': pace.notice, 'question_id': question_id, 'wait_seconds': pace.wait_seconds}


@router.post('/question/finish/', response=QuestionFinishedSchema)
def account_question_finish(
    request: AccountRequest,
    payload: QuestionFinishSchema,
) -> dict[str, object]:
    if not isinstance(payload, QuestionFinishSchema):
        message = f'payload must be a QuestionFinishSchema: {type(payload).__name__}'
        raise TypeError(message)

    question = request.auth.services.processor.question_finish(
        question_id=payload.question_id,
        tokens=payload.tokens,
    )

    return {'question_id': question.pk, 'tokens': question.tokens}
