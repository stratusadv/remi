import os

import robit

import django

_ = os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'system.production.settings')

django.setup()

from django.core.exceptions import ImproperlyConfigured
from django.db import close_old_connections

from app.account.models import Account
from system.environment import EnvironmentVariable, environment_text


ROBIT_KEY = environment_text(EnvironmentVariable.ROBIT_KEY)

if ROBIT_KEY == '':
    message = 'ROBIT_KEY must be set, because the worker dashboard can run jobs'
    raise ImproperlyConfigured(message)

robit.set_timezone('America/Edmonton')
robit.set_database_logging(True)
robit.set_controls(True)

wo = robit.Worker(
    name='remi',
    web_server=True,
    web_server_address='0.0.0.0',
    web_server_port=8080,
    key=ROBIT_KEY,
    alert_method=None,
)


def complimentary_topup_job() -> None:
    close_old_connections()

    _ = Account.services.automation.complimentary_topup()


# wo.add_group('Accounts')

# wo.add_job(
#     name='Top up complimentary accounts',
#     method=complimentary_topup_job,
#     group='Accounts',
#     cron='0 2 * * *',
# )


if __name__ == '__main__':
    wo.start()
