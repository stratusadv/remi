FROM python:3.13-slim AS build

COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

RUN apt-get update \
    && apt-get install --yes --no-install-recommends gcc libc6-dev libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml uv.lock ./

RUN uv sync --frozen --no-dev

COPY . .

RUN DJANGO_SETTINGS_MODULE=system.base_settings .venv/bin/python manage.py collectstatic --noinput

FROM python:3.13-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 remi

ENV DJANGO_SETTINGS_MODULE=system.production.settings \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY --from=build --chown=remi:remi /app /app

USER remi

EXPOSE 8000

CMD ["sh", "-c", "python manage.py migrate --noinput && exec gunicorn system.production.wsgi --bind 0.0.0.0:8000 --workers 1 --threads 4 --access-logfile -"]
