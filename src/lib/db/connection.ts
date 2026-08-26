import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// RF_Service_System의 같은 파일과 동일한 이유로 "server-only"를 넣지 않는다 —
// 이 모듈은 standalone tsx 스크립트(scripts/*.ts)도 직접 불러오는데, 그쪽은
// Next.js 번들러 밖에서 돌아 "react-server" 조건이 설정되지 않는다.
// 브라우저 번들 방지 가드는 ./client.ts에 둔다.

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Define it in .env.local (see .env.example) before using the database client."
  );
}

// Dev-safe singleton: 이게 없으면 `next dev`가 핫리로드할 때마다 새 postgres.js
// 연결 풀이 열려 결국 max_connections를 소진한다.
const globalForDb = globalThis as unknown as {
  __dssAuthPgClient?: postgres.Sql;
  __dssAuthDb?: ReturnType<typeof drizzle<typeof schema>>;
};

const queryClient =
  globalForDb.__dssAuthPgClient ??
  postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

export const db = globalForDb.__dssAuthDb ?? drizzle(queryClient, { schema });

// 깔끔한 종료가 필요한 standalone 스크립트/테스트 전용
// (열린 풀이 있으면 postgres.js가 프로세스를 계속 살려둔다).
export const pgClient = queryClient;

if (process.env.NODE_ENV !== "production") {
  globalForDb.__dssAuthPgClient = queryClient;
  globalForDb.__dssAuthDb = db;
}
