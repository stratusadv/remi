from __future__ import annotations

import re

import pytest

from decimal import Decimal
from typing_extensions import TYPE_CHECKING, Any, cast

from django.core.mail import EmailMultiAlternatives
from django.db.models import TextChoices
from django.db.models.enums import ChoicesType

from django_spire.metric.domain.statistic.constants import StatisticValueTypeChoices

from app.account.constants import SECONDS_PER_HOUR
from app.funnel import metric
from app.funnel.choices import CampaignChoices
from app.funnel.constants import FUNNEL_PROMO_CODES_SHARED
from app.funnel.mail import (
    FUNNEL_EMAIL_ADDRESS_LENGTH_MAX,
    funnel_email_address_clean,
    funnel_email_build,
    funnel_email_configured,
    funnel_email_deliver,
    funnel_email_send,
)
from app.funnel.metric import (
    FunnelStatistic,
    SalesStatistic,
    UsageStatistic,
    metric_hours,
    metric_remote_configured,
    metric_revenue,
    metric_statistics,
)
from app.funnel.promo import funnel_promo_downloaded, funnel_promo_issue
from app.promo_code.models import PromoCode
from harness.sendgrid import SENDGRID_API_KEY

if TYPE_CHECKING:
    from pytest_django.fixtures import Settings

    from harness.sendgrid import SendgridFake


pytestmark = pytest.mark.django_db
ADDRESS = 'avery@example.com'
CAMPAIGN_UNDECLARED = 'gala'


class LengthWrongChoicesType(ChoicesType):
    def __len__(self) -> int:
        assert issubclass(self, TextChoices)

        return 99


def _choices_length_wrong() -> type[TextChoices]:
    bases = (TextChoices,)
    namespace = LengthWrongChoicesType.__prepare__('LengthWrongChoices', bases)
    namespace['ONE'] = ('one', 'One')

    choices = LengthWrongChoicesType('LengthWrongChoices', bases, namespace)
    values = [str(member) for member in choices]

    assert values == ['one']
    assert len(choices) != len(values)

    return cast('type[TextChoices]', choices)


def _email_to(recipients: list[str]) -> EmailMultiAlternatives:
    assert recipients
    assert all('@' in recipient for recipient in recipients)

    return EmailMultiAlternatives(subject='remi', body='Hello.', to=recipients)


def test_email_address_clean_refuses_anything_but_text() -> None:
    number = cast('Any', 7)
    spelled = f'{number}@example.com'

    assert funnel_email_address_clean(spelled) == spelled

    with pytest.raises(TypeError, match='address must be a str: int'):
        funnel_email_address_clean(number)


def test_email_address_clean_trims_and_bounds_the_address() -> None:
    longest = 'a' * (254 - len('@example.com')) + '@example.com'

    assert len(longest) == FUNNEL_EMAIL_ADDRESS_LENGTH_MAX
    assert funnel_email_address_clean('  avery@example.com\n') == ADDRESS
    assert funnel_email_address_clean(longest) == longest

    for refused in ('', '   ', longest + 'm', 'avery', 'avery@'):
        with pytest.raises(ValueError, match='address'):
            funnel_email_address_clean(refused)


def test_email_build_and_send_refuse_an_undeclared_campaign_or_an_unclean_address(
    sendgrid_fake: SendgridFake,
) -> None:
    email = funnel_email_build(address=ADDRESS, campaign=CampaignChoices.GENERAL)

    assert email.to == [ADDRESS]
    assert funnel_email_address_clean(f' {ADDRESS}') == ADDRESS

    with pytest.raises(ValueError, match=r"campaign must be one of .*: 'gala'"):
        funnel_email_build(address=ADDRESS, campaign=CAMPAIGN_UNDECLARED)

    with pytest.raises(ValueError, match='address must arrive stripped and validated'):
        funnel_email_build(address=f' {ADDRESS}', campaign=CampaignChoices.GENERAL)

    with pytest.raises(ValueError, match=r"campaign must be one of .*: 'gala'"):
        funnel_email_send(address=ADDRESS, campaign=CAMPAIGN_UNDECLARED)

    with pytest.raises(ValueError, match='address must arrive stripped and validated'):
        funnel_email_send(address=f'{ADDRESS} ', campaign=CampaignChoices.GENERAL)

    assert sendgrid_fake.requests == []


def test_email_deliver_refuses_a_blank_key_an_undeclared_campaign_or_two_recipients(
    sendgrid_fake: SendgridFake,
) -> None:
    single = _email_to([ADDRESS])
    double = _email_to([ADDRESS, 'morgan@example.com'])

    assert len(single.to) == 1
    assert len(double.to) == 2

    with pytest.raises(ValueError, match='address_key must be non-empty'):
        funnel_email_deliver(address_key='', campaign=CampaignChoices.GENERAL, email=single)

    with pytest.raises(ValueError, match=r"campaign must be one of .*: 'gala'"):
        funnel_email_deliver(address_key='key', campaign=CAMPAIGN_UNDECLARED, email=single)

    with pytest.raises(ValueError, match='a funnel email goes to one address, not 2'):
        funnel_email_deliver(address_key='key', campaign=CampaignChoices.GENERAL, email=double)

    assert sendgrid_fake.requests == []


def test_email_configured_reads_the_key_and_refuses_a_setting_that_is_not_text(
    settings: Settings,
) -> None:
    settings.SENDGRID_API_KEY = SENDGRID_API_KEY

    assert funnel_email_configured()

    settings.SENDGRID_API_KEY = ''

    assert not funnel_email_configured()

    settings.SENDGRID_API_KEY = None

    with pytest.raises(TypeError, match='SENDGRID_API_KEY must be a str: NoneType'):
        funnel_email_configured()


def test_metric_statistics_refuses_choices_that_are_not_text_choices_or_an_unknown_type() -> None:
    sales = metric_statistics(SalesStatistic, StatisticValueTypeChoices.CURRENCY)
    not_choices = cast('Any', dict)
    message = re.escape(f'choices must be a TextChoices subclass: {not_choices!r}')
    value_type = cast('Any', 'weight')

    assert [statistic.key for statistic in sales] == ['revenue']
    assert value_type not in StatisticValueTypeChoices.values

    with pytest.raises(TypeError, match=message):
        metric_statistics(not_choices, StatisticValueTypeChoices.NUMBER)

    with pytest.raises(ValueError, match=r"value_type must be one of .*: 'weight'"):
        metric_statistics(FunnelStatistic, value_type)


def test_metric_statistics_that_lose_a_choice_are_a_programming_error() -> None:
    usage = metric_statistics(UsageStatistic, StatisticValueTypeChoices.NUMBER)

    assert [statistic.key for statistic in usage] == ['hours', 'meetings']

    with pytest.raises(RuntimeError, match='LengthWrongChoices produced 1 statistics'):
        metric_statistics(_choices_length_wrong(), StatisticValueTypeChoices.NUMBER)


def test_metric_hours_rounded_to_nothing_is_a_programming_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert metric_hours(1) == Decimal('0.0003')

    monkeypatch.setattr(metric, 'METRIC_HOURS_QUANTUM', Decimal(1))

    assert metric_hours(SECONDS_PER_HOUR // 2) == Decimal(1)

    with pytest.raises(RuntimeError, match='1 seconds rounded to 0 hours'):
        metric_hours(1)


def test_metric_revenue_that_loses_cents_is_a_programming_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert metric_revenue(150) == Decimal('1.50')

    monkeypatch.setattr(metric, 'METRIC_REVENUE_QUANTUM', Decimal(1))

    assert metric_revenue(200) == Decimal(2)

    with pytest.raises(RuntimeError, match='150 cents converted to 2 dollars'):
        metric_revenue(150)


def test_metric_remote_needs_both_settings_as_text(settings: Settings) -> None:
    settings.DJANGO_SPIRE_REMOTE_API_KEY = 'metric-key'
    settings.DJANGO_SPIRE_REMOTE_API_URL = 'https://portal.example.com/ds'

    assert metric_remote_configured()

    for key, url in (('', 'https://portal.example.com/ds'), ('metric-key', '')):
        settings.DJANGO_SPIRE_REMOTE_API_KEY = key
        settings.DJANGO_SPIRE_REMOTE_API_URL = url

        assert not metric_remote_configured()

    settings.DJANGO_SPIRE_REMOTE_API_URL = None

    with pytest.raises(TypeError, match='DJANGO_SPIRE_REMOTE_API_URL must be a str: NoneType'):
        metric_remote_configured()

    settings.DJANGO_SPIRE_REMOTE_API_URL = 'https://portal.example.com/ds'
    settings.DJANGO_SPIRE_REMOTE_API_KEY = None

    with pytest.raises(TypeError, match='DJANGO_SPIRE_REMOTE_API_KEY must be a str: NoneType'):
        metric_remote_configured()


def test_funnel_promo_helpers_refuse_a_blank_code_or_address_or_an_undeclared_campaign() -> None:
    assert CAMPAIGN_UNDECLARED not in CampaignChoices.values

    with pytest.raises(ValueError, match='code must be non-empty'):
        funnel_promo_downloaded('')

    with pytest.raises(ValueError, match=r"campaign must be one of .*: 'gala'"):
        funnel_promo_issue(address=ADDRESS, campaign=CAMPAIGN_UNDECLARED)

    with pytest.raises(ValueError, match='address must be non-empty'):
        funnel_promo_issue(address='', campaign=CampaignChoices.WIB)


def test_funnel_promo_issue_for_a_campaign_without_a_shared_code_issues_nothing() -> None:
    assert CampaignChoices.GENERAL not in FUNNEL_PROMO_CODES_SHARED

    issued = funnel_promo_issue(address=ADDRESS, campaign=CampaignChoices.GENERAL)

    assert issued is None
    assert not PromoCode.objects.exists()
