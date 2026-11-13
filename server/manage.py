import os
import sys

from django.core.management import execute_from_command_line


def main() -> None:
    _ = os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'system.development.settings')
    execute_from_command_line(sys.argv)


if __name__ == '__main__':
    main()
