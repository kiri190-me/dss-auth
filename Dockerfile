# DSS 통합 로그인 — 운영 이미지
#
# 개발 PC에서 굽고 NAS로 옮긴다. NAS(Celeron 2코어)에서 빌드하면 20분이 넘거나
# 메모리 부족으로 죽고, 그동안 다른 시스템까지 함께 느려진다.
#
#   docker build -t dss-auth:1.0 .
#   docker save dss-auth:1.0 -o dss-auth-1.0.tar
#   (NAS에서) docker load -i dss-auth-1.0.tar
#
# 마이그레이션을 돌리는 도구 이미지는 따로 굽는다(아래 「곁가지」 스테이지):
#
#   docker build --target tools -t dss-auth-tools:1 .
#   docker save dss-auth-tools:1 -o dss-auth-tools-1.tar
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

# ── 곁가지 : 마이그레이션을 돌리는 도구 이미지 ────────────────────────
#
# 운영 이미지(3단계)에서는 db:migrate를 부를 수 없다. 이유가 둘이다 —
# drizzle-kit이 devDependency고, runner는 .next/standalone만 담아 node_modules도
# drizzle/*.sql도 아예 없다. 이 스테이지가 그 자리를 맡는다.
#
#   docker build --target tools -t dss-auth-tools:1 .
#
# NAS에 이미 도는 여섯(tools-as · tools-meters · tools-improvements ·
# tools-leave · tools-board · tools-inventory)과 같은 모양이다. 포털만 없어서
# 2026-10-22 서른한째 배포에서 마이그레이션 셋(0005·0006·0007)을 돌릴 길이
# 없었다 — 그것이 이 스테이지가 생긴 까닭이다.
#
# NAS에서는 compose의 `profiles: [tools]` 서비스 tools-auth로 두고, 부를 때만
# 잠깐 떴다 사라진다(`run --rm`). 상시 서비스가 아니라 메모리 예산 밖이다.
#
# ⚠️ 이 스테이지를 runner 뒤로 옮기지 않는다. **마지막 스테이지가 `docker build`
#    의 기본 대상**이라, 뒤에 두면 `--target` 없이 구운 이미지가 앱이 아니라
#    도구가 된다 — 그 이미지는 `node server.js`를 모른다.
#
# 🔴 DATABASE_URL을 여기에 굽지 않는다. 2단계의 가짜 값은 별도 FROM이라 넘어오지
#    않고, 그래야 맞다 — 여기는 **진짜** 주소를 받아야 하는 자리다. 없는 채로
#    부르면 drizzle.config.ts가 바로 던진다(그게 맞는 동작이다). 운영에서는
#    compose가 환경변수로 넣는다. 비밀번호가 이미지에 구워져 돌아다니면 안 된다.
FROM ${NODE_IMAGE} AS tools
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Seoul

# ⚠️ 소유자는 COPY할 때 정한다. 다 옮겨 놓고 `RUN chown -R /app`을 하면 그 한 줄이
#    /app 전체를 새 레이어에 한 벌 더 복사한다 — 계측기 도구 이미지에서 실측
#    1.86GB → 1.07GB.
#
# drizzle-kit은 devDependency다. deps는 `npm ci`를 NODE_ENV 없이 돌리므로 거기
# node_modules에는 devDependency가 들어 있다 — 그래서 deps에서 가져온다.
# drizzle.config.ts가 맨 윗줄에서 부르는 dotenv도 같은 이유로 거기에 있다
# (컨테이너에 .env.local은 없다. dotenv는 파일이 없으면 조용히 지나가고,
#  값은 환경변수에서 온다 — 그래서 이 조합이 맞는다).
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json drizzle.config.ts ./

# drizzle.config.ts의 schema가 ./src/lib/db/schema/index.ts를 가리킨다.
#
# ⚠️ 이 스테이지는 builder와 달리 `COPY . .`가 아니라 폴더를 골라 담는다. 그래서
#    tsconfig.json의 paths가 가리키는 곳을 하나라도 빠뜨리면, 그 자리를 타는 순간
#    「Cannot find module」로 죽는다. A/S에서 실제로 그랬다 — 스키마를
#    vendor/dss-core로 옮기고 이 줄을 안 더해 8일간 도구 이미지가 전부 죽어
#    있었는데 태그가 같아 눈으로는 구별이 안 됐다(2026-09-29).
#    이 저장소의 paths는 `@/*` → ./src 하나뿐이고 vendor/ 서브모듈이 없다.
# 🔴 나중에 코드를 서브모듈로 옮기면, 옮긴 곳이 여기 담기는지 먼저 본다.
COPY --chown=node:node src ./src

# 🔴 돌릴 마이그레이션 자체와 목록(meta/_journal.json). 목록에 없는 .sql은 안 돈다.
#
#    **이미지에 굽는다 — 볼륨으로 붙이지 않는다.** A/S만 볼륨
#    (/volume1/dss/as-migrations)을 쓰는데, 거기는 drizzle/만 28MB라 배포마다
#    이미지를 통째로 옮기는 값이 더 컸기 때문이다. 포털의 drizzle/는 292KB다.
#    볼륨으로 하면 배포 때마다 사람이 파일을 올려야 하고, 빠뜨리면 오류가 아니라
#    「마이그레이션 0건」으로 조용히 끝난다 — 그 값이 292KB보다 비싸다. 그래서
#    개선요청·휴가·게시판·재고와 같은 쪽을 고른다.
#    대신 **마이그레이션이 늘면 이 도구 이미지를 다시 구워 옮겨야 한다.**
#
# ⚠️ .dockerignore가 drizzle/을 막으면 이 줄이 빈 폴더를 담고, 역시 오류 없이
#    0건으로 끝난다. 그 검사는 src/lib/tools-image.test.ts에 있다.
COPY --chown=node:node drizzle ./drizzle

# 비상구도 담는다. 포털은 **모든 사내 시스템의 로그인**이라 관리자가 잠기면
# 되돌릴 다른 길이 없다 — create-emergency-admin.ts·promote-admin.ts가 그 길이고,
# purge-expired.ts는 감사 로그 보관기간(3년)을 실제로 집행하는 유일한 코드다.
# 비상구는 쓸 일이 생긴 뒤에 넣을 수 없으니 미리 담는다(184KB).
#
# ⚠️ 다만 package.json의 그 스크립트들은 아직 `node --env-file=.env.local`로
#    적혀 있다. 컨테이너에 그 파일이 없으므로 `npm run admin:promote`는 그 줄에서
#    죽는다. 컨테이너에는 환경변수가 이미 들어와 있으니 파일 없이 직접 부른다:
#      … run --rm tools-auth node --import tsx scripts/promote-admin.ts
#    (그 스크립트들을 --env-file-if-exists로 고치는 것은 별도 조각이다.)
COPY --chown=node:node scripts ./scripts

USER node

# 기본값은 **아무것도 바꾸지 않는** 쪽으로 둔다. 적용은 명령을 적어 부른다:
#   docker compose … --profile tools run --rm tools-auth npm run db:migrate
CMD ["node", "-e", "console.log('db:migrate 를 명령으로 적어 부르세요.')"]

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
