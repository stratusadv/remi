from __future__ import annotations

import pytest

from typing_extensions import TYPE_CHECKING

from django.contrib.auth.models import Permission
from django.db.models import CharField
from django.urls import reverse

from app.account.admin import ACCOUNT_ACTION_COUNT_MAX, ADJUSTMENT_REASON_LENGTH_MAX
from app.account.constants import (
    ACCOUNT_LEDGER_ENTRY_REFERENCE_LENGTH_MAX,
    SECONDS_PER_HOUR,
    SECONDS_PER_MINUTE,
    TOPUP_BALANCE_SECONDS,
)
from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account
from app.account.payment.tests.factories import create_test_payment
from app.account.tests.factories import create_test_account
from app.promo_code.models import PromoCode
from app.promo_code.tests.factories import create_test_promo_code
from harness.api import ACCOUNT_PATH, account_create, account_get

if TYPE_CHECKING:
    from django.contrib.auth.models import User
    from django.test import Client
    from django.test.client import _MonkeyPatchedWSGIResponse


pytestmark = pytest.mark.django_db
ACCOUNT_CHANGELIST = 'admin:account_account_changelist'


def _adjustment_post(
    client: Client,
    account: Account,
    *,
    hours: str,
    reason: str,
) -> _MonkeyPatchedWSGIResponse:
    assert account.pk is not None
    assert hours != ''
    assert len(reason) <= ADJUSTMENT_REASON_LENGTH_MAX + 1

    url = reverse(ACCOUNT_CHANGELIST)

    data = {
        'action': 'balance_adjust',
        '_selected_action': [account.pk],
        'apply': 'yes',
        'hours': hours,
        'reason': reason,
    }

    return client.post(url, data, follow=True)


def test_account_admin_offers_no_save_and_refuses_a_change(admin_client: Client) -> None:
    account_create(admin_client)

    account = Account.objects.get()
    url = reverse('admin:account_account_change', args=[account.pk])
    page = admin_client.get(url)
    body = {'campaign': 'wib', 'email': 'mallory@example.com', 'name': 'Mallory'}
    posted = admin_client.post(url, body)

    assert page.status_code == 200
    assert b'name="_save"' not in page.content
    assert posted.status_code == 403
    assert Account.objects.values_list('email', 'name').get() == ('avery@example.com', 'Avery')


def test_account_balance_adjust_adds_the_hours_under_the_reason_once(admin_client: Client) -> None:
    account = create_test_account(seconds=SECONDS_PER_HOUR)
    reason = 'Refund for a failed upload'
    applied = _adjustment_post(admin_client, account, hours='2.5', reason=reason)
    repeated = _adjustment_post(admin_client, account, hours='2.5', reason=reason)
    notices = [str(notice) for notice in applied.context['messages']]
    entry = account.ledger_entries.adjustments().get()

    assert notices == ['The balance for avery@example.com is now 3.50 hours.']
    assert b'The balance for avery@example.com is now 3.50 hours.' in applied.content
    assert entry.seconds == 2 * SECONDS_PER_HOUR + 30 * SECONDS_PER_MINUTE
    assert entry.reference == f'admin: {reason}'
    assert repeated.status_code == 200
    assert b'was not applied again' in repeated.content
    assert account.ledger_entries.balance_seconds() == 210 * SECONDS_PER_MINUTE


def test_account_balance_adjust_asks_for_the_hours_before_writing_anything(
    admin_client: Client,
) -> None:
    account = create_test_account(seconds=90 * SECONDS_PER_MINUTE)
    url = reverse(ACCOUNT_CHANGELIST)
    data = {'action': 'balance_adjust', 'index': 0, '_selected_action': [account.pk]}
    response = admin_client.post(url, data)

    assert response.status_code == 200
    assert b'holds 1.50 hours' in response.content
    assert b'name="hours"' in response.content
    assert b'name="reason"' in response.content
    assert b'class="errornote"' not in response.content
    assert f'href="{url}" class="closelink"'.encode() in response.content
    assert not account.ledger_entries.adjustments().exists()


def test_account_balance_adjust_shows_a_balance_that_can_be_removed_in_full(
    admin_client: Client,
) -> None:
    seconds = 4997
    account = create_test_account(seconds=seconds)
    url = reverse(ACCOUNT_CHANGELIST)
    data = {'action': 'balance_adjust', 'index': 0, '_selected_action': [account.pk]}
    asked = admin_client.post(url, data)
    applied = _adjustment_post(admin_client, account, hours='-1.38', reason='Remove the balance')
    notices = [str(notice) for notice in applied.context['messages']]

    assert b'holds 1.38 hours' in asked.content
    assert notices == ['The balance for avery@example.com is now 0.00 hours.']
    assert account.ledger_entries.balance_seconds() == 29


def test_account_balance_adjust_below_zero_shows_the_refusal_and_writes_nothing(
    admin_client: Client,
) -> None:
    account = create_test_account(seconds=SECONDS_PER_HOUR)
    response = _adjustment_post(admin_client, account, hours='-2', reason='Correction')

    assert response.status_code == 200
    assert b'class="errornote"' in response.content
    assert b'The account holds 1.00 hours, so it cannot lose 2.00 hours.' in response.content
    assert not account.ledger_entries.adjustments().exists()
    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR


def test_account_balance_adjust_needs_the_change_permission(
    client: Client,
    django_user_model: type[User],
) -> None:
    assert django_user_model.USERNAME_FIELD == 'username'

    account = create_test_account(seconds=SECONDS_PER_HOUR)
    viewer = django_user_model.objects.create_user(username='viewer', is_staff=True)
    permission = Permission.objects.get(codename='view_account', content_type__app_label='account')

    viewer.user_permissions.add(permission)
    client.force_login(viewer)

    page = client.get(reverse(ACCOUNT_CHANGELIST))
    response = _adjustment_post(client, account, hours='5', reason='Refund')

    assert page.status_code == 200
    assert b'balance_adjust' not in page.content
    assert response.status_code == 200
    assert not account.ledger_entries.adjustments().exists()
    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR


def test_account_balance_adjust_reference_fits_the_longest_username_and_reason(
    django_user_model: type[User],
) -> None:
    assert django_user_model.USERNAME_FIELD == 'username'

    field = django_user_model._meta.get_field('username')

    assert isinstance(field, CharField)
    assert isinstance(field.max_length, int)

    reference_length_max = field.max_length + len(': ') + ADJUSTMENT_REASON_LENGTH_MAX

    assert reference_length_max <= ACCOUNT_LEDGER_ENTRY_REFERENCE_LENGTH_MAX


def test_account_balance_adjust_refuses_bad_hours_or_a_long_reason(admin_client: Client) -> None:
    account = create_test_account(seconds=SECONDS_PER_HOUR)
    reason_long = 'a' * (ADJUSTMENT_REASON_LENGTH_MAX + 1)

    cases = [
        ('0', 'Correction'),
        ('1000.01', 'Correction'),
        ('-1000.01', 'Correction'),
        ('1.005', 'Correction'),
        ('ten', 'Correction'),
        ('1', reason_long),
        ('1', ''),
    ]

    for hours, reason in cases:
        response = _adjustment_post(admin_client, account, hours=hours, reason=reason)

        assert response.status_code == 200, hours
        assert b'class="errornote"' in response.content, hours
        assert b'errorlist' in response.content, hours

    assert not account.ledger_entries.adjustments().exists()
    assert account.ledger_entries.balance_seconds() == SECONDS_PER_HOUR


def test_account_balance_adjust_refuses_more_than_one_account(admin_client: Client) -> None:
    first = create_test_account(email='first@example.com')
    second = create_test_account(email='second@example.com')
    url = reverse(ACCOUNT_CHANGELIST)
    data = {'action': 'balance_adjust', 'index': 0, '_selected_action': [first.pk, second.pk]}
    response = admin_client.post(url, data, follow=True)
    notices = [str(notice) for notice in response.context['messages']]

    assert notices == ['Select exactly one account.']
    assert not AccountLedgerEntry.objects.adjustments().exists()


def test_account_code_issue_needs_the_change_permission(
    client: Client,
    django_user_model: type[User],
) -> None:
    assert django_user_model.USERNAME_FIELD == 'username'

    account_create(client)

    account = Account.objects.get()
    viewer = django_user_model.objects.create_user(username='viewer', is_staff=True)
    permission = Permission.objects.get(codename='view_account', content_type__app_label='account')

    viewer.user_permissions.add(permission)
    client.force_login(viewer)

    url = reverse(ACCOUNT_CHANGELIST)
    page = client.get(url)
    data = {'action': 'code_issue', 'index': 0, '_selected_action': [account.pk]}
    response = client.post(url, data, follow=True)

    assert page.status_code == 200
    assert b'code_issue' not in page.content
    assert response.status_code == 200
    assert Account.objects.get().token_hash == account.token_hash


def test_account_code_issue_refuses_more_than_one_account(admin_client: Client) -> None:
    token = account_create(admin_client)

    account_create(admin_client, email='morgan@example.com')

    url = reverse(ACCOUNT_CHANGELIST)
    selected = list(Account.objects.values_list('pk', flat=True))
    data = {'action': 'code_issue', '_selected_action': selected}
    response = admin_client.post(url, data, follow=True)
    notices = [str(notice) for notice in response.context['messages']]
    email = account_get(admin_client, token)['email']

    assert notices == ['Select exactly one account.']
    assert email == 'avery@example.com'


def test_account_code_issued_in_the_admin_replaces_the_old_one(admin_client: Client) -> None:
    token = account_create(admin_client)
    other = account_create(admin_client, email='morgan@example.com')
    account = Account.objects.get(email='avery@example.com')
    url = reverse(ACCOUNT_CHANGELIST)
    data = {'action': 'code_issue', '_selected_action': [account.pk]}
    response = admin_client.post(url, data, follow=True)
    notices = [str(notice) for notice in response.context['messages']]
    code = notices[0].split(' is now ')[1].split('. ')[0]
    headers = {'Authorization': f'Bearer {token}'}
    stale = admin_client.get(ACCOUNT_PATH, headers=headers)
    email = account_get(admin_client, code)['email']
    email_other = account_get(admin_client, other)['email']

    assert len(notices) == 1
    assert code != token
    assert email == 'avery@example.com'
    assert stale.status_code == 401
    assert email_other == 'morgan@example.com'


def test_account_complimentary_actions_need_the_change_permission(
    client: Client,
    django_user_model: type[User],
) -> None:
    assert django_user_model.USERNAME_FIELD == 'username'

    account = create_test_account()
    viewer = django_user_model.objects.create_user(username='viewer', is_staff=True)
    permission = Permission.objects.get(codename='view_account', content_type__app_label='account')

    viewer.user_permissions.add(permission)
    client.force_login(viewer)

    url = reverse(ACCOUNT_CHANGELIST)
    page = client.get(url)
    data = {'action': 'complimentary_start', 'index': 0, '_selected_action': [account.pk]}
    response = client.post(url, data, follow=True)

    assert page.status_code == 200
    assert b'complimentary_start' not in page.content
    assert b'complimentary_end' not in page.content
    assert response.status_code == 200
    assert not Account.objects.get().is_complimentary
    assert not account.ledger_entries.grants().exists()


def test_account_complimentary_end_clears_the_flag_and_keeps_the_hours(
    admin_client: Client,
) -> None:
    account = create_test_account()

    _ = account.services.processor.complimentary_start(reference='topup:test:1')

    url = reverse(ACCOUNT_CHANGELIST)
    data = {'action': 'complimentary_end', '_selected_action': [account.pk]}
    response = admin_client.post(url, data, follow=True)
    notices = [str(notice) for notice in response.context['messages']]
    notice = 'The selected accounts are no longer complimentary. Their hours stay.'

    assert notices == [notice]
    assert not Account.objects.get().is_complimentary
    assert account.ledger_entries.balance_seconds() == TOPUP_BALANCE_SECONDS


def test_account_complimentary_start_flags_and_tops_up_each_selected_account(
    admin_client: Client,
) -> None:
    empty = create_test_account(email='empty@example.com')
    full = create_test_account(email='full@example.com', seconds=TOPUP_BALANCE_SECONDS)
    url = reverse(ACCOUNT_CHANGELIST)
    data = {'action': 'complimentary_start', '_selected_action': [empty.pk, full.pk]}
    response = admin_client.post(url, data, follow=True)
    notices = [str(notice) for notice in response.context['messages']]
    notice = 'The selected accounts are complimentary, topped up to 1,000 hours.'

    assert notices == [notice]
    assert Account.objects.complimentary().count() == 2
    assert empty.ledger_entries.balance_seconds() == TOPUP_BALANCE_SECONDS
    assert full.ledger_entries.balance_seconds() == TOPUP_BALANCE_SECONDS
    assert not full.ledger_entries.grants().exists()

    grant = empty.ledger_entries.grants().get()

    assert grant.reference.startswith('topup:admin:')


def test_account_complimentary_start_refuses_more_accounts_than_its_maximum(
    admin_client: Client,
) -> None:
    for index in range(ACCOUNT_ACTION_COUNT_MAX + 1):
        create_test_account(email=f'person{index}@example.com')

    url = reverse(ACCOUNT_CHANGELIST)
    selected = list(Account.objects.values_list('pk', flat=True))
    data = {'action': 'complimentary_start', '_selected_action': selected}
    response = admin_client.post(url, data, follow=True)
    notices = [str(notice) for notice in response.context['messages']]

    assert notices == [f'Select at most {ACCOUNT_ACTION_COUNT_MAX} accounts at once.']
    assert not Account.objects.complimentary().exists()
    assert not AccountLedgerEntry.objects.grants().exists()


def test_admin_pages_render_for_each_model(admin_client: Client) -> None:
    promo = create_test_promo_code(code='WIB2026', hours=5)

    account_create(admin_client, promo_code='WIB2026')

    account = Account.objects.get()
    entry = AccountLedgerEntry.objects.get()
    payment = create_test_payment(account)

    urls = [
        reverse(ACCOUNT_CHANGELIST),
        reverse(ACCOUNT_CHANGELIST) + '?o=5',
        reverse('admin:account_account_change', args=[account.pk]),
        reverse('admin:account_ledger_accountledgerentry_changelist'),
        reverse('admin:account_ledger_accountledgerentry_change', args=[entry.pk]),
        reverse('admin:account_payment_accountpayment_changelist'),
        reverse('admin:account_payment_accountpayment_change', args=[payment.pk]),
        reverse('admin:promo_code_promocode_add'),
        reverse('admin:promo_code_promocode_change', args=[promo.pk]),
        reverse('admin:promo_code_promocode_changelist'),
    ]

    for url in urls:
        response = admin_client.get(url)

        assert response.status_code == 200, url

    changelist = admin_client.get(reverse(ACCOUNT_CHANGELIST))

    assert b'5.0' in changelist.content
    assert PromoCode.objects.get().hours == 5
