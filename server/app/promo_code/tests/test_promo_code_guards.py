from __future__ import annotations

import re

import pytest

from typing_extensions import TYPE_CHECKING, Any, cast

from django.contrib import admin
from django.db import IntegrityError, transaction
from django.test import RequestFactory
from django.urls import reverse

from app.account.constants import (
    ACCOUNT_EMAIL_LENGTH_MAX,
    ACCOUNT_NAME_LENGTH_MAX,
    SECONDS_PER_HOUR,
)
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account
from app.account.tests.factories import create_test_account
from app.core.exceptions import PromoInvalidError
from app.funnel.choices import CampaignChoices
from app.promo_code.admin import (
    PROMO_CODE_ACTION_COUNT_MAX,
    PROMO_CODE_FOLLOW_UP_EMAILED,
    PromoCodeAdmin,
    PromoCodeFollowUpFilter,
)
from app.promo_code.constants import (
    PROMO_CODE_INVALID_MESSAGE,
    PROMO_CODE_ISSUE_ALPHABET,
    PROMO_CODE_ISSUE_GROUP_COUNT,
    PROMO_CODE_ISSUE_GROUP_LENGTH,
    PROMO_CODE_LENGTH_MAX,
)
from app.promo_code.models import PromoCode
from app.promo_code.services import processor_service
from app.promo_code.tests.factories import create_test_promo_code

if TYPE_CHECKING:
    from django.test import Client


pytestmark = pytest.mark.django_db
MESSAGE_INVALID = re.escape(PROMO_CODE_INVALID_MESSAGE)
PROMO_CHANGELIST = 'admin:promo_code_promocode_changelist'


def _shared_wib() -> PromoCode:
    return create_test_promo_code(campaign=CampaignChoices.WIB, code='WIB2026', hours=50)


def test_promo_filters_refuse_an_undeclared_campaign_or_a_code_or_email_out_of_bounds() -> None:
    promo = create_test_promo_code(code='P' * PROMO_CODE_LENGTH_MAX)
    promos = PromoCode.objects.all()

    assert promos.by_campaign(CampaignChoices.GENERAL).get() == promo
    assert promos.by_code('p' * PROMO_CODE_LENGTH_MAX).get() == promo
    assert not promos.by_email('a' * ACCOUNT_EMAIL_LENGTH_MAX).exists()

    with pytest.raises(ValueError, match=r"campaign must be one of .*: 'gala'"):
        promos.by_campaign('gala')

    for code in ('', 'P' * 65):
        with pytest.raises(ValueError, match='code must be 1 to 64 characters'):
            promos.by_code(code)

    for email in ('', 'a' * 255):
        with pytest.raises(ValueError, match='email must be 1 to 254 characters'):
            promos.by_email(email)


def test_issued_code_text_refuses_an_undeclared_campaign_or_an_overlong_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    code = processor_service._code_issue_text(CampaignChoices.WIB)
    prefix, *groups = code.split('-')

    assert prefix == 'WIB'
    assert len(groups) == PROMO_CODE_ISSUE_GROUP_COUNT
    assert {len(group) for group in groups} == {PROMO_CODE_ISSUE_GROUP_LENGTH}
    assert set(''.join(groups)) <= set(PROMO_CODE_ISSUE_ALPHABET)

    with pytest.raises(ValueError, match=r"campaign must be one of .*: 'gala'"):
        processor_service._code_issue_text('gala')

    monkeypatch.setattr(processor_service, 'PROMO_CODE_ISSUE_GROUP_COUNT', 20)

    with pytest.raises(RuntimeError, match='an issued promo code has 103 characters'):
        processor_service._code_issue_text(CampaignChoices.WIB)


def test_personal_code_create_refuses_a_code_out_of_bounds_or_a_blank_email() -> None:
    processor = _shared_wib().services.processor

    for code in ('', 'P' * 65):
        with pytest.raises(ValueError, match='code must be 1 to 64 characters'):
            processor._issue_create(code=code, email='avery@example.com')

    with pytest.raises(ValueError, match='a personal promo code is issued to an email address'):
        processor._issue_create(code='WIB-2345-6789', email='')

    assert PromoCode.objects.count() == 1

    personal = processor._issue_create(code='P' * PROMO_CODE_LENGTH_MAX, email='avery@example.com')

    assert PromoCode.objects.issued().get() == personal
    assert personal.redemptions_max == 1


def test_unsaved_promo_codes_refuse_to_lock_issue_or_redeem() -> None:
    account = create_test_account()
    unsaved = PromoCode(campaign=CampaignChoices.WIB, code='WIB2026', hours=5, redemptions_max=9)

    with pytest.raises(ValueError, match='the promo code must be saved'):
        unsaved.services.processor._promo_locked()

    with pytest.raises(ValueError, match='the promo code must be saved'):
        unsaved.services.processor.issue('avery@example.com')

    with pytest.raises(ValueError, match='the promo code must be saved'):
        unsaved.services.processor.redeem(account)

    assert not PromoCode.objects.exists()
    assert not account.ledger_entries.exists()
    assert Account.objects.get().campaign == CampaignChoices.GENERAL


def test_redeem_refuses_an_unsaved_account() -> None:
    promo = _shared_wib()
    unsaved = Account(email='unsaved@example.com', name='Unsaved')
    message = re.escape(f'account must be saved: {unsaved!r}')

    with pytest.raises(ValueError, match=message):
        promo.services.processor.redeem(unsaved)

    assert not AccountLedgerEntry.objects.exists()
    assert not Account.objects.exists()

    account = create_test_account()

    promo.services.processor.redeem(account)

    assert account.ledger_entries.balance_seconds() == 50 * SECONDS_PER_HOUR


@pytest.mark.django_db(transaction=True)
def test_promo_lock_and_redeem_outside_a_transaction_are_programming_errors() -> None:
    promo = _shared_wib()
    account = create_test_account()

    assert not transaction.get_connection().in_atomic_block

    with pytest.raises(RuntimeError, match='locked inside the transaction that writes it'):
        promo.services.processor._promo_locked()

    with pytest.raises(RuntimeError, match='redeemed inside the transaction that locked it'):
        promo.services.processor.redeem(account)

    assert not AccountLedgerEntry.objects.exists()
    assert Account.objects.get(pk=account.pk).campaign == CampaignChoices.GENERAL


def test_redeem_of_an_inactive_or_deleted_promo_is_refused_and_credits_nothing() -> None:
    account = create_test_account()
    inactive = create_test_promo_code(code='PAUSED', hours=5)
    deleted = create_test_promo_code(code='GONE', hours=5)

    inactive.set_inactive()
    deleted.set_deleted()

    for promo in (inactive, deleted):
        with pytest.raises(PromoInvalidError, match=MESSAGE_INVALID):
            promo.services.processor.redeem(account)

        with pytest.raises(PromoInvalidError, match=MESSAGE_INVALID):
            account.services.processor.promo_redeem(promo.code)

    assert not account.ledger_entries.exists()
    assert Account.objects.get().campaign == CampaignChoices.GENERAL


def test_terms_save_refuses_an_undeclared_campaign_no_hours_or_a_negative_limit() -> None:
    processor = _shared_wib().services.processor

    with pytest.raises(ValueError, match=r"campaign must be one of .*: 'gala'"):
        processor.terms_save(campaign='gala', hours=5, redemptions_max=1)

    for hours in (0, -1):
        with pytest.raises(ValueError, match=f'hours must be positive: {hours}'):
            processor.terms_save(campaign=CampaignChoices.WIB, hours=hours, redemptions_max=1)

    with pytest.raises(ValueError, match='redemptions_max must be non-negative: -1'):
        processor.terms_save(campaign=CampaignChoices.WIB, hours=5, redemptions_max=-1)

    promo = PromoCode.objects.get()

    assert (promo.campaign, promo.hours, promo.redemptions_max) == ('wib', 50, 100)

    processor.terms_save(campaign=CampaignChoices.GENERAL, hours=1, redemptions_max=0)
    promo.refresh_from_db()

    assert (promo.campaign, promo.hours, promo.redemptions_max) == ('general', 1, 0)


def test_terms_save_with_no_redemptions_left_closes_the_code() -> None:
    promo = _shared_wib()
    account = create_test_account()

    promo.services.processor.terms_save(campaign=CampaignChoices.WIB, hours=50, redemptions_max=0)

    assert PromoCode.objects.get().redemptions_max == 0

    with pytest.raises(PromoInvalidError, match='That promo code has been fully redeemed'):
        account.services.processor.promo_redeem('WIB2026')

    assert not account.ledger_entries.exists()


def test_early_save_refuses_negative_terms_codes_without_hours_or_a_personal_code() -> None:
    shared = _shared_wib()
    processor = shared.services.processor
    personal = processor.issue('avery@example.com')

    with pytest.raises(ValueError, match='early_codes_max must be non-negative: -1'):
        processor.early_save(early_codes_max=-1, early_hours=75)

    with pytest.raises(ValueError, match='early_hours must be non-negative: -1'):
        processor.early_save(early_codes_max=0, early_hours=-1)

    with pytest.raises(ValueError, match='early codes need early hours above zero: 20 codes'):
        processor.early_save(early_codes_max=20, early_hours=0)

    with pytest.raises(ValueError, match='only a shared promo code has early terms'):
        personal.services.processor.early_save(early_codes_max=20, early_hours=75)

    stored = PromoCode.objects.get(pk=shared.pk)

    assert (stored.early_codes_max, stored.early_hours) == (0, 0)

    processor.early_save(early_codes_max=0, early_hours=75)
    stored.refresh_from_db()

    assert (stored.early_codes_max, stored.early_hours) == (0, 75)
    assert PromoCode.objects.get(pk=personal.pk).early_hours == 0


def test_promo_code_rows_refuse_early_codes_without_hours_or_on_a_personal_code() -> None:
    with pytest.raises(IntegrityError), transaction.atomic():
        create_test_promo_code(code='BARE', early_codes_max=1)

    with pytest.raises(IntegrityError), transaction.atomic():
        PromoCode.objects.create(
            campaign=CampaignChoices.WIB,
            code='WIB-2345-6789',
            early_hours=75,
            email='avery@example.com',
            hours=50,
            redemptions_max=1,
        )

    assert not PromoCode.objects.exists()


def test_issue_refuses_a_name_longer_than_an_account_name() -> None:
    processor = _shared_wib().services.processor
    name_long = 'N' * (ACCOUNT_NAME_LENGTH_MAX + 1)

    with pytest.raises(ValueError, match='name_first has at most 200 characters: 201'):
        processor.issue('avery@example.com', name_first=name_long)

    with pytest.raises(ValueError, match='name_last has at most 200 characters: 201'):
        processor.issue('avery@example.com', name_last=name_long)

    assert not PromoCode.objects.issued().exists()


def test_promo_admin_follow_up_filter_refuses_a_list_of_another_kind() -> None:
    personal = _shared_wib().services.processor.issue('avery@example.com')
    request = RequestFactory().get('/')
    parameters = {'follow_up': ['emailed']}
    promo_admin = PromoCodeAdmin(PromoCode, admin.site)
    follow_up = PromoCodeFollowUpFilter(request, parameters, PromoCode, promo_admin)
    not_queryset = cast('Any', [])
    message = f'must be a PromoCodeQuerySet: {type(not_queryset).__name__}'

    assert follow_up.value() == PROMO_CODE_FOLLOW_UP_EMAILED
    assert list(follow_up.queryset(request, PromoCode.objects.all())) == [personal]

    with pytest.raises(TypeError, match=message):
        follow_up.queryset(request, not_queryset)


def test_promo_admin_save_refuses_an_object_that_is_not_a_promo_code() -> None:
    request = RequestFactory().post('/')
    promo_admin = PromoCodeAdmin(PromoCode, admin.site)
    account = cast('Any', create_test_account())
    form = cast('Any', None)
    promo = PromoCode(campaign=CampaignChoices.WIB, code='WIB2026', hours=5, redemptions_max=9)
    message = f'obj must be a PromoCode: {type(account).__name__}'

    with pytest.raises(TypeError, match=message):
        promo_admin.save_model(request, account, form, change=True)

    promo_admin.save_model(request, promo, form, change=False)

    assert PromoCode.objects.get() == promo


def test_promo_admin_toggles_refuse_more_codes_than_its_maximum(admin_client: Client) -> None:
    for index in range(PROMO_CODE_ACTION_COUNT_MAX + 1):
        create_test_promo_code(code=f'BULK{index}', hours=1)

    url = reverse(PROMO_CHANGELIST)
    selected = list(PromoCode.objects.values_list('pk', flat=True))
    data = {'action': 'promo_deactivate', '_selected_action': selected}
    response = admin_client.post(url, data, follow=True)
    notices = [str(notice) for notice in response.context['messages']]

    assert notices == [f'Select at most {PROMO_CODE_ACTION_COUNT_MAX} promo codes at once.']
    assert PromoCode.objects.active().count() == PROMO_CODE_ACTION_COUNT_MAX + 1
