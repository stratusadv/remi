from __future__ import annotations

import time

import pytest

from typing_extensions import TYPE_CHECKING

from app.account.constants import SECONDS_PER_HOUR
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account
from app.core.exceptions import PromoInvalidError
from app.funnel.choices import CampaignChoices
from app.promo_code.tests.factories import create_test_promo_code
from harness.api import (
    ACCOUNT_CHARGE_PATH,
    ACCOUNT_PATH,
    account_create,
    account_get,
    api_post,
    checkout_finish,
    checkout_start,
    stripe_event_deliver,
)
from harness.fixtures import PRICE_HOURS
from harness.stripe import STRIPE_WEBHOOK_SECRET, stripe_event_payload, stripe_signature_header

if TYPE_CHECKING:
    from django.test import Client

    from pytest_django.fixtures import Settings

    from harness.stripe import StripeFake


pytestmark = pytest.mark.django_db
EVENT_COMPLETED = 'checkout.session.completed'
JOB_ID = '86dfb1d3b0140ecf2fd59075421f1cb5'
JOB_ID_SECOND = '47ead100cc5cd956aa10b3c4d5e6f708'
PURCHASE_SECONDS = PRICE_HOURS * SECONDS_PER_HOUR


def _webhook_completed(client: Client, session_id: str) -> int:
    assert session_id.startswith('cs_')

    payload = stripe_event_payload(event_type=EVENT_COMPLETED, session_id=session_id)
    timestamp = int(time.time())
    header = stripe_signature_header(payload, secret=STRIPE_WEBHOOK_SECRET, timestamp=timestamp)

    return stripe_event_deliver(client, header=header, payload=payload).status_code


def _charge(client: Client, token: str, *, job_id: str, seconds: int) -> int:
    assert token
    assert len(job_id) == len(JOB_ID)
    assert seconds > 0

    body = {'job_id': job_id, 'seconds': seconds}
    return api_post(client, ACCOUNT_CHARGE_PATH, body=body, token=token).status_code


def test_the_token_of_a_deleted_account_signs_nothing_in(client: Client) -> None:
    token = account_create(client)
    headers = {'Authorization': f'Bearer {token}'}

    Account.objects.get().set_deleted()

    response = client.get(ACCOUNT_PATH, headers=headers)

    assert response.status_code == 401
    assert response.json()['error']['code'] == 'token_invalid'


def test_one_recording_charged_on_two_accounts_is_taken_from_each_once(client: Client) -> None:
    create_test_promo_code(code='HOUR', hours=1)

    avery = account_create(client, promo_code='HOUR')
    morgan = account_create(client, email='morgan@example.com', promo_code='HOUR')

    for token in (avery, morgan, avery, morgan):
        charge_status = _charge(client, token, job_id=JOB_ID, seconds=600)

        assert charge_status == 200

    balance_seconds_avery = account_get(client, avery)['balance_seconds']
    balance_seconds_morgan = account_get(client, morgan)['balance_seconds']

    assert balance_seconds_avery == SECONDS_PER_HOUR - 600
    assert balance_seconds_morgan == SECONDS_PER_HOUR - 600
    assert AccountLedgerEntry.objects.charges().count() == 2


def test_a_charge_of_exactly_the_balance_empties_it_and_the_next_second_is_refused(
    client: Client,
) -> None:
    create_test_promo_code(code='HOUR', hours=1)

    token = account_create(client, promo_code='HOUR')
    charge_status_exact = _charge(client, token, job_id=JOB_ID, seconds=SECONDS_PER_HOUR)
    balance_seconds = account_get(client, token)['balance_seconds']

    assert charge_status_exact == 200
    assert balance_seconds == 0

    charge_status_extra = _charge(client, token, job_id=JOB_ID_SECOND, seconds=1)

    assert charge_status_extra == 402
    assert AccountLedgerEntry.objects.charges().count() == 1


def test_a_charge_sent_again_with_another_duration_keeps_the_first(client: Client) -> None:
    create_test_promo_code(code='HOUR', hours=1)

    token = account_create(client, promo_code='HOUR')
    charge_status_first = _charge(client, token, job_id=JOB_ID, seconds=600)
    charge_status_again = _charge(client, token, job_id=JOB_ID, seconds=1800)
    charge_status_later = _charge(client, token, job_id=JOB_ID, seconds=SECONDS_PER_HOUR + 1)
    balance_seconds = account_get(client, token)['balance_seconds']

    assert charge_status_first == 200
    assert charge_status_again == 200
    assert charge_status_later == 200
    assert balance_seconds == SECONDS_PER_HOUR - 600


def test_a_pack_bought_before_the_offers_change_credits_what_was_bought(
    client: Client,
    settings: Settings,
    stripe_fake: StripeFake,
) -> None:
    token = account_create(client)
    session_id = checkout_start(client, hours=PRICE_HOURS, token=token)

    settings.REMI_OFFERS = {10: 300, 200: 3000}
    stripe_fake.pay(session_id)

    finished = checkout_finish(client, session_id=session_id, token=token)
    balance_seconds = account_get(client, token)['balance_seconds']
    offers = account_get(client, token)['offers']

    assert finished.status_code == 200
    assert finished.json()['paid'] is True
    assert balance_seconds == PURCHASE_SECONDS
    assert offers == [
        {'currency': 'cad', 'hours': 10, 'price_cents': 300},
        {'currency': 'cad', 'hours': 200, 'price_cents': 3000},
    ]


@pytest.mark.parametrize('order', ['finish_first', 'webhook_first'])
def test_a_paid_session_finished_and_announced_by_webhook_is_credited_once(
    client: Client,
    order: str,
    stripe_fake: StripeFake,
) -> None:
    assert order in ('finish_first', 'webhook_first')

    token = account_create(client)
    session_id = checkout_start(client, hours=PRICE_HOURS, token=token)

    stripe_fake.pay(session_id)

    if order == 'finish_first':
        finished = checkout_finish(client, session_id=session_id, token=token)
        webhook_status = _webhook_completed(client, session_id)
    else:
        webhook_status = _webhook_completed(client, session_id)
        finished = checkout_finish(client, session_id=session_id, token=token)

    assert webhook_status == 200
    assert finished.status_code == 200
    assert finished.json()['paid'] is True
    assert finished.json()['account']['balance_seconds'] == PURCHASE_SECONDS
    assert AccountLedgerEntry.objects.purchases().count() == 1


def test_a_personal_code_credits_whoever_redeems_it_first_and_then_no_one(client: Client) -> None:
    shared = create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026', hours=50)
    personal = shared.services.processor.issue('avery@example.com')

    morgan = account_create(client, email='morgan@example.com', promo_code=personal.code)
    avery_account, _ = Account.services.factory.create(
        email='avery@example.com',
        name='Avery',
        promo_code='',
        region='CA-AB',
    )

    with pytest.raises(PromoInvalidError, match='That promo code has been fully redeemed'):
        avery_account.services.processor.promo_redeem(personal.code)

    balance_seconds = account_get(client, morgan)['balance_seconds']

    assert balance_seconds == 50 * SECONDS_PER_HOUR
    assert not avery_account.ledger_entries.exists()
    assert Account.objects.get(email='morgan@example.com').campaign == CampaignChoices.WIB
