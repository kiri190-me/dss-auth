# DSS 통합 로그인 — 운영 이미지
#
# 개발 PC에서 굽고 NAS로 옮긴다. NAS(Celeron 2코어)에서 빌드하면 20분이 넘거나
# 메모리 부족으로 죽고, 그동안 다른 시스템까지 함께 느려진다.
#
#   docker build -t dss-auth:1.0 .
#   docker save dss-auth:1.0 -o dss-auth-1.0.tar
#   (NAS에서) docker load -i dss-auth-1.0.tar
#
# 자세한 것은 ../dss-deploy/runbook/02-이미지-빌드.md

# Next 16이 요구하는 최소 Node는 20.9다. LTS인 22를 쓴다.
# alpine이 아니라 bookworm(Debian)인 이유: musl이 아니라 glibc가 필요하고,
# PostgreSQL 공식 저장소에서 클라이언트를 받아야 하기 때문이다.
ARG NODE_IMAGE=node:22-bookworm-slim

# ── 1단계 : 라이브러리만 설치한다 ─────────────────────────────────────
#
# package 파일만 먼저 복사한다. 도커는 바뀌지 않은 단계를 건너뛰는데,
# 소스를 먼저 복사하면 화면 한 줄만 고쳐도 라이브러리를 처음부터 다시 깐다.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── 2단계 : 앱을 굽는다 ───────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 빌드에만 쓰는 가짜 DATABASE_URL.
#
# 왜 필요한가: `next build`는 각 화면의 데이터를 모으려고 서버 모듈을 실제로
# 불러온다. /apps가 DB 클라이언트를 부르는데, connection.ts가 모듈을 읽는
# 순간 DATABASE_URL이 있는지 검사하고 없으면 던진다. 개발 PC에서는 .env.local이
# 있어 지나가지만, 이미지에는 .dockerignore가 .env*를 막아 두어(그게 맞다)
# 값이 없다.
#
# 접속은 하지 않는다 — postgres.js는 실제로 쓸 때 연결한다. 값이 "있기만"
# 하면 된다. 그래서 누가 봐도 가짜인 값을 쓴다.
#
# 이 값은 이 단계에만 있고 최종 이미지에는 남지 않는다(3단계는 별도 FROM이다).
# 운영에서는 컨테이너 환경변수로 진짜 값이 들어오고, 없으면 앱이 뜨면서
# 같은 검사에 걸려 바로 죽는다 — 그게 맞는 동작이다.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build_time_only"

# next.config.ts의 output: "standalone"이 .next/standalone을 만든다.
RUN npm run build

# ── 3단계 : 실행에 필요한 것만 담는다 ─────────────────────────────────
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production

# pg_dump — 백업이 BACKUP_MODE=direct 로 부른다.
# ⚠️ Debian bookworm의 기본 저장소에는 15까지만 있다. 서버가 17이므로
#    클라이언트도 17이어야 하고(낮으면 거절당한다), 그래서 PostgreSQL 공식
#    저장소를 먼저 추가한다.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-17; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*

# standalone은 public과 .next/static을 자동으로 담지 않는다(Next 문서 output.md).
# 빠뜨리면 화면은 뜨는데 이미지와 CSS가 전부 깨져 보인다.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# 캐시 폴더를 미리 만들어 둔다. 없으면 실행 중에 만들려다 권한에서 막힌다.
RUN mkdir -p .next/cache && chown -R node:node /app

# 관리자 권한으로 돌지 않는다. 뚫려도 할 수 있는 일이 줄어든다.
USER node

# ⚠️ 서명 개인키(keys/)는 이미지에 넣지 않는다 — .dockerignore가 막고 있다.
#    운영에서는 볼륨으로 붙이고 AUTH_KEYS_DIR로 경로를 준다. 이미지는 파일로
#    복사되어 돌아다니므로, 키가 한 번 들어가면 회수할 방법이 없다.
#
# HOSTNAME=0.0.0.0 이 필요한 이유: 기본값은 localhost라 컨테이너 밖에서
# (리버스 프록시에서조차) 닿지 못한다.
ENV PORT=3100 HOSTNAME=0.0.0.0
EXPOSE 3100

CMD ["node", "server.js"]
