# syntax=docker/dockerfile:1
#
# The Sump image (REQ-000004-sJpO9KMY Requirement 5): the Sump, Redis and Fluent
# Bit in one container, run by supervisord as the non-root user `sump`. Not
# published before per-user session tokens exist (roadmap Items 11 and 12).

FROM python:3.13-slim-bookworm AS builder
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
# Build the virtualenv at the path it runs from: its scripts' shebangs are
# absolute, so a venv built elsewhere and copied would not run.
WORKDIR /opt/correlate-sump
COPY pyproject.toml uv.lock README.md ./
COPY src src
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.13-slim-bookworm AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg redis-server supervisor \
    && curl -fsSL https://packages.fluentbit.io/fluentbit.key \
        | gpg --dearmor -o /usr/share/keyrings/fluentbit-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/fluentbit-keyring.gpg] https://packages.fluentbit.io/debian/bookworm bookworm main" \
        > /etc/apt/sources.list.d/fluentbit.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends fluent-bit \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --uid 10001 sump \
    && install -d -o sump -g sump -m 0700 /var/lib/correlate-sump

COPY --from=builder /opt/correlate-sump/.venv /opt/correlate-sump/.venv
COPY container/fluent-bit.conf /etc/fluent-bit/fluent-bit.conf
COPY container/supervisord.conf /etc/supervisor/supervisord.conf

ENV PATH="/opt/correlate-sump/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    SUMP_HOST=0.0.0.0 \
    SUMP_PORT=8765

USER sump
WORKDIR /home/sump
EXPOSE 8765 5140

# Healthy only when the Sump answers and Redis is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import json,sys,urllib.request; sys.exit(0 if json.load(urllib.request.urlopen('http://127.0.0.1:8765/health'))['redis'] else 1)"

CMD ["supervisord", "-c", "/etc/supervisor/supervisord.conf"]
