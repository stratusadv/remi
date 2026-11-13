import pytest

from typing_extensions import cast

from django.core.exceptions import ImproperlyConfigured

from system.environment import (
    EnvironmentVariable,
    environment_currency,
    environment_flag,
    environment_list,
    environment_offers,
    environment_publishable_key,
    environment_text,
)


def test_currency_is_lowercased_defaulted_and_refused_unless_three_letters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    variable = EnvironmentVariable.REMI_PRICE_CURRENCY

    monkeypatch.delenv(variable.name, raising=False)

    unset = environment_currency(variable, default='cad')

    monkeypatch.setenv(variable.name, ' USD ')

    upper = environment_currency(variable, default='cad')

    assert unset == 'cad'
    assert upper == 'usd'

    for value in ['us', 'usdd', 'çad', '12a', 'u d']:
        monkeypatch.setenv(variable.name, value)

        with pytest.raises(ImproperlyConfigured, match='three-letter ISO currency code'):
            environment_currency(variable, default='cad')

    with pytest.raises(ImproperlyConfigured, match='not a lowercase three-letter code'):
        environment_currency(variable, default='CAD')


def test_flag_reads_zero_one_or_unset_and_refuses_anything_else(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    variable = EnvironmentVariable.DJANGO_DEBUG

    monkeypatch.delenv(variable.name, raising=False)

    unset = environment_flag(variable)

    monkeypatch.setenv(variable.name, '1')

    on = environment_flag(variable)

    monkeypatch.setenv(variable.name, '0')

    off = environment_flag(variable)

    assert not unset
    assert on
    assert not off

    for value in ['yes', 'true', '2']:
        monkeypatch.setenv(variable.name, value)

        with pytest.raises(ImproperlyConfigured, match='must be 0 or 1'):
            environment_flag(variable)


def test_list_splits_on_commas_and_drops_blank_items(monkeypatch: pytest.MonkeyPatch) -> None:
    variable = EnvironmentVariable.DJANGO_ALLOWED_HOSTS

    monkeypatch.setenv(variable.name, ' remi.example.com, ,api.example.com,, ')

    hosts = environment_list(variable)

    monkeypatch.delenv(variable.name)

    assert hosts == ['remi.example.com', 'api.example.com']
    assert environment_list(variable) == []


def test_offers_read_hours_and_prices_in_hours_order_and_refuse_the_rest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    variable = EnvironmentVariable.REMI_OFFERS
    default = '10:300,50:1000'

    monkeypatch.delenv(variable.name, raising=False)

    unset = environment_offers(variable, default=default)

    monkeypatch.setenv(variable.name, ' 200:3000, 1:50 ,10000:100000 ')

    listed = environment_offers(variable, default=default)

    assert unset == {10: 300, 50: 1000}
    assert listed == {1: 50, 200: 3000, 10000: 100_000}
    assert list(listed) == sorted(listed)

    cases = [
        ('50', 'hours:price_cents'),
        ('50:', 'hours:price_cents'),
        ('50:10.00', 'hours:price_cents'),
        ('-5:300', 'hours:price_cents'),
        ('10:300,', 'empty offer'),
        ('0:300', 'outside 1 to 10000'),
        ('10001:300', 'outside 1 to 10000'),
        ('10:49', 'outside 50 to 100000'),
        ('10:100001', 'outside 50 to 100000'),
        ('10:300,10:500', 'more than once'),
        ('1:50,2:60,3:70,4:80,5:90', 'more than 4'),
    ]

    for value, phrase in cases:
        monkeypatch.setenv(variable.name, value)

        with pytest.raises(ImproperlyConfigured, match=phrase):
            environment_offers(variable, default=default)

    monkeypatch.delenv(variable.name)

    with pytest.raises(ImproperlyConfigured, match='hours:price_cents'):
        environment_offers(variable, default='fifty')

    with pytest.raises(ImproperlyConfigured, match='no default offers'):
        environment_offers(variable, default=' ')


def test_publishable_key_refuses_a_secret_key_without_repeating_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    variable = EnvironmentVariable.STRIPE_PUBLISHABLE_KEY

    monkeypatch.delenv(variable.name, raising=False)

    unset = environment_publishable_key(variable)

    monkeypatch.setenv(variable.name, ' pk_test_51Hscribe ')

    test = environment_publishable_key(variable)

    monkeypatch.setenv(variable.name, 'pk_live_51Hscribe')

    live = environment_publishable_key(variable)

    assert unset == ''
    assert test == 'pk_test_51Hscribe'
    assert live == 'pk_live_51Hscribe'

    secret = 'sk_test_51Hscribe'

    refused = [
        secret,
        'rk_live_51Hscribe',
        'pk_test_',
        'pk_prod_51Hscribe',
        'pk_test_51H remi',
    ]

    for value in refused:
        monkeypatch.setenv(variable.name, value)

        with pytest.raises(ImproperlyConfigured, match='publishable key') as raised:
            environment_publishable_key(variable)

        assert secret not in str(raised.value)
        assert '51H' not in str(raised.value)


def test_text_is_stripped_and_refuses_a_name_outside_the_enumeration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    variable = EnvironmentVariable.DJANGO_SITE_DOMAIN

    monkeypatch.setenv(variable.name, '  remi.example.com\n')

    padded = environment_text(variable)

    monkeypatch.delenv(variable.name)

    assert padded == 'remi.example.com'
    assert environment_text(variable) == ''

    with pytest.raises(TypeError, match='must be an EnvironmentVariable'):
        environment_text(cast('EnvironmentVariable', 'DJANGO_SITE_DOMAIN'))
