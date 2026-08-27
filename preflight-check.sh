#!/usr/bin/env bash
# Preflight for incident-engine — validates the environment the NEXT run will
# actually use. Fleet paradigm (data_acquisition/docs/migration_CLAUDE.md);
# adapted from monday's preflight, with data_acquisition's cert-mounting
# Postgres check (this app deploys PG_SSLMODE=verify-full). A clean run
# reports ZERO warnings: treat a persistent warning as a bug in the check
# itself, or it trains people to ignore output.
#
# Exit codes: 0 = pass (or warnings only), 1 = critical errors found.
set -u
cd "$(dirname "$0")"

ERRORS=0; WARNINGS=0; OKS=0
ok()    { echo "  OK    $*"; OKS=$((OKS+1)); }
warn()  { echo "  WARN  $*"; WARNINGS=$((WARNINGS+1)); }
error() { echo "  ERROR $*"; ERRORS=$((ERRORS+1)); }
info()  { echo "        $*"; }
section(){ echo; echo "== $* =="; }

# Read KEY= from .env, stripping quotes, dotenv-style inline comments and
# trailing whitespace. NEVER source an app .env in scripts (fleet rule).
env_val() {
    grep "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- \
        | sed -e 's/[[:space:]]\+#.*$//' -e 's/[[:space:]]*$//' \
              -e "s/^['\"]//" -e "s/['\"]$//"
}

# ---------------------------------------------------------------- 1. host dirs
section "Host directories"
# The run-log dir the next run will actually use: LOG_DIR from .env, or the
# compose default (the in-tree dev path) when unset.
LOG_DIR_V="$(env_val LOG_DIR)"; LOG_DIR_V="${LOG_DIR_V:-./utils/logger/logs}"
if [ -d "$LOG_DIR_V" ] && [ -w "$LOG_DIR_V" ]; then
    ok "log dir $LOG_DIR_V writable ($(stat -c '%U:%G %a' "$LOG_DIR_V"))"
elif [ -d "$LOG_DIR_V" ]; then
    error "log dir $LOG_DIR_V exists but is not writable by $(id -un) ($(stat -c '%U:%G %a' "$LOG_DIR_V"))"
else
    case "$LOG_DIR_V" in
        /opt/run-logs/*)
            error "log dir $LOG_DIR_V missing — create it svc:docker 2775 BEFORE the first release run (entrypoint.sh will not re-chown a deliberate owner)" ;;
        *)
            warn "log dir $LOG_DIR_V missing (docker/entrypoint.sh creates it on first docker run)" ;;
    esac
fi

PG_SSL_PATH_V="$(env_val PG_SSL_PATH)"
if [ -n "$PG_SSL_PATH_V" ] && [ -r "$PG_SSL_PATH_V" ]; then
    ok "PG_SSL_PATH readable ($PG_SSL_PATH_V)"
else
    error "PG_SSL_PATH missing or unreadable ($PG_SSL_PATH_V) — pg-pool throws at require-time under verify-*"
fi

# ------------------------------------------------------------------- 2. docker
section "Docker"
if docker ps >/dev/null 2>&1; then ok "docker daemon reachable"; else error "docker daemon not reachable as $(id -un)"; fi
if id -nG | grep -qw docker; then ok "$(id -un) is in the docker group"; else error "$(id -un) not in docker group"; fi
if docker compose version >/dev/null 2>&1; then ok "docker compose available"; else error "docker compose not available"; fi

USER_ID_V="$(env_val USER_ID)"
if [ -n "$USER_ID_V" ]; then
    if docker image inspect "incident-engine:${USER_ID_V}" >/dev/null 2>&1; then
        ok "image incident-engine:${USER_ID_V} present"
    else
        error "image incident-engine:${USER_ID_V} missing — run: bash build.sh"
    fi
fi

# ----------------------------------------------------------------- 3. networks
section "Networks"
if docker network inspect pg_net >/dev/null 2>&1; then ok "network pg_net exists"; else error "network pg_net missing"; fi

# --------------------------------------------------------------------- 4. .env
section ".env"
if [ ! -f .env ]; then
    error ".env missing — copy .env.example and fill it in"
else
    REQUIRED="APP_NAME USER_ID LOGGER_MODE LOG_DIR
              PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PG_SSLMODE PG_SSL_PATH
              DOCKER_GID UID_0 UID_1 UID_2"
    for key in $REQUIRED; do
        v="$(env_val "$key")"
        if [ -z "$v" ]; then
            error ".env: $key is empty or missing"
        else
            case "$key" in
                *PW*|*PASSWORD*|*TOKEN*|*KEY*|*SECRET*) ok ".env: $key set (masked)" ;;
                *) ok ".env: $key=$v" ;;
            esac
        fi
    done

    # index.js fails boot on any other APP_NAME, and the DB-side check-option
    # view rejects the insert — catch the config mistake here first.
    APP_NAME_V="$(env_val APP_NAME)"
    if [ -n "$APP_NAME_V" ] && [ "$APP_NAME_V" != "incident-engine" ]; then
        error ".env: APP_NAME must be 'incident-engine' (got '$APP_NAME_V')"
    fi

    LOGGER_MODE_V="$(env_val LOGGER_MODE)"
    case "$LOGGER_MODE_V" in
        log|log_and_console|"") : ;;
        *) error ".env: LOGGER_MODE must be 'log' or 'log_and_console' (got '$LOGGER_MODE_V')" ;;
    esac

    # Retired by the 2026-08 migration: the RUN_ENV switch defaulted unset to
    # the PRODUCTION log path (fail-unsafe), RUN_LOGS_DIR was a raw bind spec,
    # LOGGER was the filename tag USER_ID now carries.
    for retired in RUN_ENV RUN_LOGS_DIR LOGGER IMAGE_TAG RUN_USER; do
        grep -q "^$retired=" .env && warn ".env: retired key $retired still present — remove it (see .env.example)"
    done
fi

# ---------------------------------------------------------------- 5. app files
section "Application files"
for f in index.js package.json docker/Dockerfile docker/entrypoint.sh docker-compose.yaml build.sh build-release.sh; do
    if [ -f "$f" ]; then ok "$f present"; else error "$f missing"; fi
done
for d in jobs domain db utils/db utils/logger utils/classify; do
    if [ -d "$d" ]; then ok "$d/ present"; else error "$d/ missing"; fi
done
if [ -e utils/.git ]; then error "utils/.git exists — utils must be app-owned, not a nested repo"; else ok "utils/ is app-owned (no nested .git)"; fi

# --------------------------------------------------------------------- 6. deps
section "Dependencies"
if [ -d node_modules ] && [ -n "$(ls -A node_modules 2>/dev/null)" ]; then
    ok "root node_modules present ($(ls node_modules | wc -l) entries)"
else
    error "root node_modules missing or empty — run: bash build.sh"
fi

# ------------------------------------------------- 7. external services (AUTH)
section "External services (authenticated checks)"

# The Postgres auth test MUST run from a sibling container on pg_net, never
# via `docker exec <pg_container> psql`: pg_hba trusts local and loopback, so
# an exec'd psql succeeds with a deliberately WRONG password (that path hid a
# rotated password for three weeks on a sibling app). This mirrors how the app
# connects (utils/db/pg-pool.js): verify-full with the CA from PG_SSL_PATH.
PGHOST_V="$(env_val PGHOST)"; PGPORT_V="$(env_val PGPORT)"; PGUSER_V="$(env_val PGUSER)"
PGPASSWORD_V="$(env_val PGPASSWORD)"; PGDATABASE_V="$(env_val PGDATABASE)"
PG_SSLMODE_V="$(env_val PG_SSLMODE)"; PG_SSLMODE_V="${PG_SSLMODE_V:-require}"
if [ -z "$PGPASSWORD_V" ]; then
    error "PGPASSWORD empty in .env — cannot verify PostgreSQL authentication"
elif ! docker image inspect postgres:16 >/dev/null 2>&1; then
    # An unverified check must never look like a passing one.
    warn "postgres:16 image absent — PostgreSQL auth NOT verified"
    info "Fix: docker pull postgres:16   (needed only for this check)"
else
    PG_OUT=$(docker run --rm --network pg_net \
        -e PGPASSWORD="$PGPASSWORD_V" -e PGSSLMODE="$PG_SSLMODE_V" -e PGSSLROOTCERT=/ssl.crt \
        -e PGCONNECT_TIMEOUT=10 \
        -v "$PG_SSL_PATH_V":/ssl.crt:ro postgres:16 \
        psql -h "$PGHOST_V" -p "$PGPORT_V" -U "$PGUSER_V" -d "$PGDATABASE_V" \
             -tAc "SELECT 'ok'" 2>&1)
    if [ "$(echo "$PG_OUT" | tail -1 | tr -d '[:space:]')" = "ok" ]; then
        ok "PostgreSQL auth OK (sibling-container $PG_SSLMODE_V connection as $PGUSER_V)"
    elif echo "$PG_OUT" | grep -qi "password authentication failed\|no password supplied"; then
        error "PostgreSQL rejected PGPASSWORD from .env — likely a rotated credential"
        info "Fix: check the secret with its owner; update BOTH copies' .env (dev clone + release)"
    elif echo "$PG_OUT" | grep -qi "certificate\|SSL"; then
        error "PostgreSQL SSL failure: $(echo "$PG_OUT" | head -2)"
    else
        error "PostgreSQL check failed: $(echo "$PG_OUT" | head -2)"
    fi
fi

# This app has no other externals: no Redis, no third-party APIs. Its inputs
# (util.app_run_logs, stats.acquisition_history) and outputs (incidents.*)
# are all behind the one Postgres role verified above.

# ----------------------------------------------- release currency (fleet-wide)
# FLEET-FINDINGS §4.1: two sessions shipped a release believing it contained
# work that existed only in the dev tree. Currency is a continuous property —
# check it on every preflight, from either copy.
section "Release currency"
if [ -d .git ]; then
    REL_DIR="/opt/apps/$(basename "$(pwd)")"
    REL_SHA="$(grep '^RELEASE_SHA=' "$REL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'\"[:space:]")"
    HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"
    if [ -z "$HEAD_SHA" ]; then
        warn "cannot read git HEAD here — release currency not checked"
    elif [ -z "$REL_SHA" ]; then
        warn "no RELEASE_SHA at $REL_DIR/.env — release copy missing or never released"
    elif [ "$(git rev-parse --quiet --verify "$REL_SHA^{commit}" 2>/dev/null)" = "$HEAD_SHA" ]; then
        ok "release copy is current (RELEASE_SHA=$REL_SHA = HEAD)"
        [ -n "$(git status --porcelain 2>/dev/null)" ] && info "note: this tree has uncommitted changes — they are in NO release"
    else
        BEHIND="$(git rev-list --count "$REL_SHA..HEAD" 2>/dev/null)"
        if [ -n "$BEHIND" ] && [ "$BEHIND" -gt 0 ] 2>/dev/null; then
            warn "release copy is $BEHIND commit(s) behind HEAD (RELEASE_SHA=$REL_SHA) — /opt/apps runs OLD code until build-release.sh"
        else
            warn "deployed RELEASE_SHA=$REL_SHA is not an ancestor of HEAD (rebase? branch switch?) — verify what /opt/apps is running"
        fi
    fi
else
    REL_SHA="$(env_val RELEASE_SHA)"
    if [ -n "$REL_SHA" ]; then
        ok "release copy stamped RELEASE_SHA=$REL_SHA"
    else
        error "no RELEASE_SHA in this .env — this copy was not produced by build-release.sh"
    fi
fi

# ------------------------------------------------------------------ 8. summary
section "Summary"
echo "  $OKS ok, $WARNINGS warnings, $ERRORS errors"
if [ "$ERRORS" -gt 0 ]; then
    echo "  RESULT: FAIL"
    exit 1
fi
[ "$WARNINGS" -gt 0 ] && echo "  RESULT: PASS (with warnings — a clean run should report zero)"
[ "$WARNINGS" -eq 0 ] && echo "  RESULT: PASS"
