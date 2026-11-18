from __future__ import annotations

import pytest

from typing_extensions import TYPE_CHECKING

from django.contrib import admin
from django.contrib.auth.models import AnonymousUser, Permission
from django.test import RequestFactory
from django.urls import reverse

from app.account.admin import ACCOUNT_ACTION_COUNT_MAX, AccountAdmin
from app.account.constants import SECONDS_PER_HOUR
from app.account.models import Account
from app.account.tests.factories import create_test_account

if TYPE_CHECKING:
    from django.contrib.auth.models import User
    from django.test import Client


pytestmark = pytest.mark.django_db
ACCOUNT_CHANGELIST = 'admin:account_account_changelist'


def test_account_admin_grants_its_actions_only_to_a_user_with_the_change_permission(
    django_user_model: type[User],
) -> None:
    assert django_user_model.USERNAME_FIELD == 'username'

    account_admin = AccountAdmin(Account, admin.site)
    request = RequestFactory().get('/')
    editor = django_user_model.objects.create_user(username='editor', is_staff=True)
    viewer = django_user_model.objects.create_user(username='viewer', is_staff=True)
    permissions = Permission.objects.filter(content_type__app_label='account')
    permission = permissions.get(codename='change_account')

    editor.user_permissions.add(permission)

    checks = [
        account_admin.has_code_issue_permission,
        account_admin.has_complimentary_end_permission,
        account_admin.has_complimentary_start_permission,
    ]

    for user, permitted in ((AnonymousUser(), False), (viewer, False), (editor, True)):
        request.user = user

        for check in checks:
            assert check(request) is permitted, (user, check.__name__)


def test_account_admin_reads_the_balance_from_the_ledger_when_it_is_not_annotated() -> None:
    account_admin = AccountAdmin(Account, admin.site)
    account = create_test_account(seconds=3 * SECONDS_PER_HOUR // 2)
    annotated = Account.objects.with_balance().get(pk=account.pk)

    assert not hasattr(account, 'balance_seconds')
    assert account_admin.balance_hours(account) == '1.5'
    assert account_admin.balance_hours(annotated) == '1.5'


def test_account_complimentary_end_refuses_more_accounts_than_its_maximum(
    admin_client: Client,
) -> None:
    for index in range(ACCOUNT_ACTION_COUNT_MAX + 1):
        account = create_test_account(email=f'person{index}@example.com')

        _ = account.services.processor.complimentary_start(reference=f'topup:test:{index}')

    url = reverse(ACCOUNT_CHANGELIST)
    selected = list(Account.objects.values_list('pk', flat=True))
    data = {'action': 'complimentary_end', '_selected_action': selected}
    response = admin_client.post(url, data, follow=True)
    notices = [str(notice) for notice in response.context['messages']]

    assert notices == [f'Select at most {ACCOUNT_ACTION_COUNT_MAX} accounts at once.']
    assert Account.objects.complimentary().count() == ACCOUNT_ACTION_COUNT_MAX + 1


def test_account_admin_refuses_to_add_an_account(admin_client: Client) -> None:
    url = reverse('admin:account_account_add')
    page = admin_client.get(url)
    body = {'email': 'mallory@example.com', 'name': 'Mallory'}
    posted = admin_client.post(url, body)

    assert page.status_code == 403
    assert posted.status_code == 403
    assert not Account.objects.exists()
