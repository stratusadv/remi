from __future__ import annotations

import threading

import pytest

from typing_extensions import TYPE_CHECKING

from django.db import connection
from django.urls import reverse

from app.account.constants import SECONDS_PER_HOUR
from app.account.ledger.models import AccountLedgerEntry
from app.account.ledger.querysets import AccountLedgerEntryQuerySet
from app.account.models import Account
from app.account.tests.factories import create_test_account
from app.core.exceptions import PromoInvalidError
from app.funnel.choices import CampaignChoices
from app.promo_code.models import PromoCode
from app.promo_code.tests.factories import create_test_promo_code
from harness.api import ACCOUNT_PATH, ACCOUNT_PROMO_PATH, account_create, account_get, api_post

if TYPE_CHECKING:
    from django.test import Client


pytestmark = pytest.mark.django_db
LOCK_HOLD_SECONDS = 1.0
PROMO_CHANGELIST = 'admin:promo_code_promocode_changelist'
THREAD_WAIT_SECONDS = 10.0


def test_promo_code_admin_creates_edits_and_toggles_a_code(admin_client: Client) -> None:
    body_add = {'campaign': 'wib', 'code': 'WIB2026', 'hours': 250, 'redemptions_max': 100}
    added = admin_client.post(reverse('admin:promo_code_promocode_add'), body_add)
    promo = PromoCode.objects.get()
    url_change = reverse('admin:promo_code_promocode_change', args=[promo.pk])
    body_change = {'campaign': 'general', 'code': 'RENAMED', 'hours': 300, 'redemptions_max': 5}
    changed = admin_client.post(url_change, body_change)
    changed_promo = PromoCode.objects.get()

    assert added.status_code == 302
    assert changed.status_code == 302
    assert changed_promo.code == 'WIB2026'
    assert changed_promo.campaign == CampaignChoices.GENERAL
    assert changed_promo.hours == 300
    assert changed_promo.redemptions_max == 5

    url_list = reverse(PROMO_CHANGELIST)
    data_deactivate = {'action': 'promo_deactivate', '_selected_action': [promo.pk]}

    admin_client.post(url_list, data_deactivate)

    assert PromoCode.objects.get().is_active is False

    data_activate = {'action': 'promo_activate', '_selected_action': [promo.pk]}

    admin_client.post(url_list, data_activate)

    assert PromoCode.objects.get().is_active is True


def test_promo_code_longer_than_the_limit_or_blank_is_refused() -> None:
    account = create_test_account(seconds=SECONDS_PER_HOUR)

    with pytest.raises(PromoInvalidError, match='at most 64 characters'):
        account.services.processor.promo_redeem('X' * 65)

    with pytest.raises(PromoInvalidError, match='Enter a promo code'):
        account.services.processor.promo_redeem('   ')

    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR


def test_promo_code_matches_without_regard_to_case_and_credits_its_hours(client: Client) -> None:
    create_test_promo_code(code='WIB2026', hours=250)

    token = account_create(client, promo_code='  wib2026 ')

    assert account_get(client, token)['balance_seconds'] == 250 * SECONDS_PER_HOUR


def test_promo_code_redeemed_after_signup_credits_once(client: Client) -> None:
    create_test_promo_code(code='LATER', hours=10)

    token = account_create(client)
    body_lower = {'code': 'later'}
    body_upper = {'code': 'LATER'}
    first = api_post(client, ACCOUNT_PROMO_PATH, body=body_lower, token=token)
    second = api_post(client, ACCOUNT_PROMO_PATH, body=body_upper, token=token)

    assert first.status_code == 200
    assert first.json()['balance_seconds'] == 10 * SECONDS_PER_HOUR
    assert second.status_code == 400
    assert 'already redeemed' in second.json()['error']['message']
    assert account_get(client, token)['balance_seconds'] == 10 * SECONDS_PER_HOUR


@pytest.mark.django_db(transaction=True)
def test_promo_code_redeemed_at_once_by_two_accounts_respects_its_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    create_test_promo_code(code='ONCE', redemptions_max=1)

    accounts = {
        'first': create_test_account(email='first@example.com'),
        'second': create_test_account(email='second@example.com'),
    }

    counted_first = threading.Event()
    done_second = threading.Event()
    outcomes = {}
    by_email_original = AccountLedgerEntryQuerySet.by_email

    def by_email_pausing(
        queryset: AccountLedgerEntryQuerySet,
        email: str,
    ) -> AccountLedgerEntryQuerySet:
        if threading.current_thread().name == 'first':
            if not counted_first.is_set():
                counted_first.set()
                done_second.wait(timeout=LOCK_HOLD_SECONDS)

        return by_email_original(queryset, email)

    def redeem() -> None:
        name = threading.current_thread().name

        try:
            accounts[name].services.processor.promo_redeem('ONCE')
        except PromoInvalidError as error:
            outcomes[name] = str(error)
        else:
            outcomes[name] = 'redeemed'
        finally:
            if name == 'second':
                done_second.set()

            connection.close()

    monkeypatch.setattr(AccountLedgerEntryQuerySet, 'by_email', by_email_pausing)

    first = threading.Thread(target=redeem, name='first')
    second = threading.Thread(target=redeem, name='second')

    first.start()

    assert counted_first.wait(timeout=THREAD_WAIT_SECONDS)

    second.start()
    first.join(timeout=THREAD_WAIT_SECONDS)
    second.join(timeout=THREAD_WAIT_SECONDS)
    monkeypatch.undo()

    assert outcomes == {
        'first': 'redeemed',
        'second': 'That promo code has been fully redeemed.',
    }

    assert AccountLedgerEntry.objects.promos().count() == 1


def test_promo_code_rejected_when_inactive_exhausted_unknown_or_reused(client: Client) -> None:
    create_test_promo_code(code='OFF', is_active=False)
    create_test_promo_code(code='ONCE', redemptions_max=1)
    create_test_promo_code(code='WIB2026')

    account_create(client, email='first@example.com', promo_code='ONCE')
    account_create(client, email='avery@example.com', promo_code='WIB2026')

    cases = [
        ('someone@example.com', 'OFF', 'not valid'),
        ('someone@example.com', 'ONCE', 'fully redeemed'),
        ('AVERY@example.com', 'WIB2026', 'already redeemed'),
        ('someone@example.com', 'NOPE', 'not valid'),
    ]

    accounts_before = Account.objects.count()

    for email, code, phrase in cases:
        body = {'email': email, 'name': 'Avery', 'promo_code': code}
        response = api_post(client, ACCOUNT_PATH, body=body)

        assert response.status_code == 400, code
        assert response.json()['error']['code'] == 'promo_invalid'
        assert phrase in response.json()['error']['message']

    assert Account.objects.count() == accounts_before
