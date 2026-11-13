from __future__ import annotations

import re
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
from app.promo_code.constants import PROMO_CODE_ISSUE_ATTEMPTS_MAX
from app.promo_code.models import PromoCode
from app.promo_code.services import processor_service
from app.promo_code.tests.factories import create_test_promo_code
from harness.api import ACCOUNT_PATH, ACCOUNT_PROMO_PATH, account_create, account_get, api_post

if TYPE_CHECKING:
    from collections.abc import Callable

    from django.test import Client


pytestmark = pytest.mark.django_db
CODE_GROUP = '[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}'
CODE_PATTERN = re.compile(f'WIB-{CODE_GROUP}-{CODE_GROUP}')
ISSUE_SAMPLES = 120
LOCK_HOLD_SECONDS = 1.0
PROMO_CHANGELIST = 'admin:promo_code_promocode_changelist'
THREAD_WAIT_SECONDS = 10.0


def _code_texts(*texts: str) -> Callable[[str], str]:
    queued = list(texts)

    def code_issue_text(campaign: str) -> str:
        _ = campaign

        return queued.pop(0)

    return code_issue_text


def _wib_shared(hours: int = 50) -> PromoCode:
    return create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026', hours=hours)


def test_issued_codes_carry_the_campaign_an_unambiguous_body_and_the_shared_terms() -> None:
    shared = _wib_shared(hours=40)

    issued = [
        shared.services.processor.issue(f'person{index}@example.com')
        for index in range(ISSUE_SAMPLES)
    ]

    codes = {promo.code for promo in issued}

    assert len(codes) == ISSUE_SAMPLES
    assert all(CODE_PATTERN.fullmatch(code) for code in codes)
    assert {promo.campaign for promo in issued} == {CampaignChoices.WIB}
    assert {promo.hours for promo in issued} == {40}
    assert {promo.redemptions_max for promo in issued} == {1}
    assert PromoCode.objects.issued().count() == ISSUE_SAMPLES
    assert list(PromoCode.objects.shared()) == [shared]


def test_an_address_keeps_one_code_in_any_case_and_only_a_shared_code_issues() -> None:
    shared = _wib_shared()
    first = shared.services.processor.issue('Avery@Example.com')
    again = shared.services.processor.issue('avery@example.com')

    assert again.pk == first.pk
    assert PromoCode.objects.issued().count() == 1

    with pytest.raises(ValueError, match='only a shared promo code issues'):
        first.services.processor.issue('morgan@example.com')

    with pytest.raises(ValueError, match='email must be 1 to 254 characters'):
        shared.services.processor.issue('')


def test_an_issued_code_that_collides_is_drawn_again(monkeypatch: pytest.MonkeyPatch) -> None:
    shared = _wib_shared()
    taken = shared.services.processor.issue('morgan@example.com')
    code_issue_text = _code_texts(taken.code.lower(), 'WIB-2345-6789')

    monkeypatch.setattr(processor_service, '_code_issue_text', code_issue_text)

    issued = shared.services.processor.issue('avery@example.com')

    assert issued.code == 'WIB-2345-6789'
    assert issued.email == 'avery@example.com'
    assert PromoCode.objects.issued().count() == 2


def test_an_issue_that_never_finds_a_free_code_gives_up(monkeypatch: pytest.MonkeyPatch) -> None:
    shared = _wib_shared()
    taken = shared.services.processor.issue('morgan@example.com')
    codes_taken = [taken.code] * PROMO_CODE_ISSUE_ATTEMPTS_MAX
    code_issue_text = _code_texts(*codes_taken)

    monkeypatch.setattr(processor_service, '_code_issue_text', code_issue_text)

    with pytest.raises(RuntimeError, match='no personal wib code was free in 8 tries'):
        shared.services.processor.issue('avery@example.com')

    assert PromoCode.objects.issued().count() == 1


def test_an_issue_racing_another_for_the_same_address_returns_the_winner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shared = _wib_shared()
    code_original = processor_service._code_issue_text

    def code_issue_text_raced(campaign: str) -> str:
        monkeypatch.setattr(processor_service, '_code_issue_text', code_original)

        winner = PromoCode(
            campaign=CampaignChoices.WIB,
            code='WIB-WWWW-2222',
            email='AVERY@example.com',
            hours=50,
            redemptions_max=1,
        )

        winner.services.save_model_obj()

        return code_original(campaign)

    monkeypatch.setattr(processor_service, '_code_issue_text', code_issue_text_raced)

    issued = shared.services.processor.issue('avery@example.com')

    assert issued.code == 'WIB-WWWW-2222'
    assert PromoCode.objects.issued().count() == 1


def test_a_campaign_offer_is_redeemed_once_per_email_and_general_codes_stack(
    client: Client,
) -> None:
    shared = _wib_shared()
    personal = shared.services.processor.issue('avery@example.com')
    create_test_promo_code(code='FRIEND', hours=3)
    create_test_promo_code(code='PODCAST', hours=4)

    token = account_create(client, promo_code='WIB2026')
    body_personal = {'code': personal.code}
    body_other = {'email': 'AVERY@example.com', 'name': 'Avery', 'promo_code': personal.code}
    stacked = api_post(client, ACCOUNT_PROMO_PATH, body=body_personal, token=token)
    other_account = api_post(client, ACCOUNT_PATH, body=body_other)

    assert stacked.status_code == 400
    assert other_account.status_code == 400
    assert other_account.json()['error']['message'] == stacked.json()['error']['message']
    assert stacked.json()['error']['message'] == (
        'This email address already redeemed the Women in Business offer.'
    )

    body_friend = {'code': 'FRIEND'}
    body_podcast = {'code': 'PODCAST'}
    friend = api_post(client, ACCOUNT_PROMO_PATH, body=body_friend, token=token)
    podcast = api_post(client, ACCOUNT_PROMO_PATH, body=body_podcast, token=token)

    assert friend.status_code == 200
    assert podcast.status_code == 200
    assert account_get(client, token)['balance_seconds'] == (50 + 3 + 4) * SECONDS_PER_HOUR


def test_only_a_personal_code_records_a_download_and_keeps_the_first() -> None:
    shared = _wib_shared()
    personal = shared.services.processor.issue('avery@example.com')

    personal.services.processor.download_record()

    stamped = PromoCode.objects.get(pk=personal.pk).downloaded_datetime

    personal.services.processor.download_record()

    assert stamped is not None
    assert PromoCode.objects.get(pk=personal.pk).downloaded_datetime == stamped

    with pytest.raises(ValueError, match='only a personal promo code records its download'):
        shared.services.processor.download_record()


def test_promo_code_admin_follow_up_lists_codes_emailed_but_never_used(
    admin_client: Client,
) -> None:
    shared = _wib_shared()
    waiting = shared.services.processor.issue('waiting@example.com')
    downloaded = shared.services.processor.issue('downloaded@example.com')
    redeemed = shared.services.processor.issue('redeemed@example.com')

    downloaded.services.processor.download_record()
    redeemed.services.processor.download_record()
    account_create(admin_client, email='redeemed@example.com', promo_code=redeemed.code)

    url = reverse(PROMO_CHANGELIST)
    query_emailed = {'follow_up': 'emailed'}
    query_downloaded = {'follow_up': 'downloaded'}
    emailed = admin_client.get(url, query_emailed)
    stuck = admin_client.get(url, query_downloaded)
    everything = admin_client.get(url)

    assert [promo.code for promo in emailed.context['cl'].queryset] == [waiting.code]
    assert [promo.code for promo in stuck.context['cl'].queryset] == [downloaded.code]
    assert everything.context['cl'].queryset.count() == 4
    assert b'waiting@example.com' in everything.content


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
