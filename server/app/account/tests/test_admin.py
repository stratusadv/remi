from __future__ import annotations

import pytest

from typing_extensions import TYPE_CHECKING

from django.contrib.auth.models import Permission
from django.urls import reverse

from app.account.ledger.models import AccountLedgerEntry
from app.account.models import Account
from app.promo_code.models import PromoCode
from app.promo_code.tests.factories import create_test_promo_code
from harness.api import ACCOUNT_PATH, account_create, account_get

if TYPE_CHECKING:
    from django.contrib.auth.models import User
    from django.test import Client


pytestmark = pytest.mark.django_db
ACCOUNT_CHANGELIST = 'admin:account_account_changelist'


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


def test_account_code_issue_needs_the_change_permission(
    client: Client,
    django_user_model: type[User],
) -> None:
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

    assert notices == ['Select exactly one account.']
    assert account_get(admin_client, token)['email'] == 'avery@example.com'


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

    assert len(notices) == 1
    assert code != token
    assert account_get(admin_client, code)['email'] == 'avery@example.com'
    assert stale.status_code == 401
    assert account_get(admin_client, other)['email'] == 'morgan@example.com'


def test_admin_pages_render_for_each_model(admin_client: Client) -> None:
    promo = create_test_promo_code(code='WIB2026', hours=5)

    account_create(admin_client, promo_code='WIB2026')

    account = Account.objects.get()
    entry = AccountLedgerEntry.objects.get()

    urls = [
        reverse(ACCOUNT_CHANGELIST),
        reverse(ACCOUNT_CHANGELIST) + '?o=5',
        reverse('admin:account_account_change', args=[account.pk]),
        reverse('admin:account_ledger_accountledgerentry_changelist'),
        reverse('admin:account_ledger_accountledgerentry_change', args=[entry.pk]),
        reverse('admin:promo_code_promocode_add'),
        reverse('admin:promo_code_promocode_change', args=[promo.pk]),
        reverse('admin:promo_code_promocode_changelist'),
    ]

    for url in urls:
        assert admin_client.get(url).status_code == 200, url

    changelist = admin_client.get(reverse(ACCOUNT_CHANGELIST))

    assert b'5.0' in changelist.content
    assert PromoCode.objects.get().hours == 5
