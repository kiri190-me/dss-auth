/**
 * 주소 진단 — "지금 이 기계는 스스로를 뭐라고 부르고 있는가".
 *
 * 왜 있는가: 주소가 어긋났을 때의 증상은 언제나 "로그인이 안 된다" 하나로
 * 뭉뚱그려진다. issuer가 틀렸는지, 등록된 redirect_uri가 틀렸는지, 카카오
 * 콘솔만 안 맞는지가 화면에 드러나지 않는다. 그래서 어긋날 수 있는 값을
 * 한자리에 펼쳐 놓고, 사람이 손대야만 하는 것(카카오 콘솔)을 따로 짚는다.
 *
 * 사용법:  npm run net:doctor
 */
import { eq } from "drizzle-orm";
import { db, pgClient } from "../src/lib/db/connection";
import { clients } from "../src/lib/db/schema";
import {
  collectLanAddresses,
  expandLanPlaceholder,
  hasLanPlaceholder,
  resolveAutoUrl,
  type InterfaceSnapshot,
} from "../src/lib/config/lan-address";
import { networkInterfaces } from "node:os";

const DEFAULT_PORT = 3100;

/** 사설 대역 IPv4가 주소 자리에 박혀 있는가. 자리표시자를 안 쓴 값을 찾는다. */
function hardcodedHost(uri: string): string | null {
  let host: string;
  try {
    host = new URL(uri).hostname;
  } catch {
    return null;
  }
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ? host : null;
}

function resolveSetting(name: string, addresses: string[]): string | null {
  const raw = process.env[name];
  if (!raw) return null;
  if (!addresses[0]) return raw;
  try {
    return resolveAutoUrl(raw, DEFAULT_PORT, addresses[0]);
  } catch {
    return raw;
  }
}

async function main() {
  const snapshot = networkInterfaces() as InterfaceSnapshot;
  const addresses = collectLanAddresses(snapshot);
  const primary = addresses[0];

  console.log("\nDSS 통합 로그인 — 주소 진단\n");

  // ───── 1. 이 기계의 주소 ─────
  console.log("이 기계의 사내망 주소");
  if (addresses.length === 0) {
    console.log("  (없음) 랜/Wi-Fi가 끊겨 있습니다. auto로 둔 값은 전부 실패합니다.");
  }
  for (const [index, address] of addresses.entries()) {
    const names = Object.entries(snapshot)
      .filter(([, list]) => (list ?? []).some((e) => e.address === address))
      .map(([name]) => name);
    console.log(
      `  ${index === 0 ? "▸" : " "} ${address.padEnd(16)}${names.join(", ")}` +
        (index === 0 ? "   ← auto가 쓰는 대표 주소" : "")
    );
  }

  // ───── 2. 풀린 설정값 ─────
  const issuer = resolveSetting("OIDC_ISSUER", addresses);
  const kakao =
    process.env.KAKAO_REDIRECT_URI === "auto"
      ? issuer && `${issuer}/api/kakao/callback`
      : (process.env.KAKAO_REDIRECT_URI ?? null);

  console.log("\n풀린 설정값");
  for (const [name, raw, resolved] of [
    ["OIDC_ISSUER", process.env.OIDC_ISSUER, issuer],
    ["KAKAO_REDIRECT_URI", process.env.KAKAO_REDIRECT_URI, kakao],
  ] as const) {
    const arrow = raw === resolved ? "" : `  →  ${resolved}`;
    console.log(`  ${name.padEnd(19)}${raw ?? "(설정 안 됨)"}${arrow}`);
  }

  // ───── 3. 등록된 시스템 ─────
  const rows = await db
    .select({
      clientId: clients.clientId,
      redirectUris: clients.redirectUris,
      postLogout: clients.postLogoutRedirectUris,
      launcherUrl: clients.launcherUrl,
      backchannel: clients.backchannelLogoutUri,
    })
    .from(clients)
    .where(eq(clients.isActive, true));

  const stale: string[] = [];

  console.log("\n등록된 시스템");
  for (const row of rows.sort((a, b) => a.clientId.localeCompare(b.clientId))) {
    console.log(`\n  ${row.clientId}`);
    const entries: [string, string[]][] = [
      ["redirect_uri", row.redirectUris],
      ["post_logout", row.postLogout],
      ["launcher", row.launcherUrl ? [row.launcherUrl] : []],
      ["backchannel", row.backchannel ? [row.backchannel] : []],
    ];
    for (const [label, uris] of entries) {
      for (const uri of uris) {
        if (hasLanPlaceholder(uri)) {
          const [expanded] = expandLanPlaceholder(uri, primary ? [primary] : []);
          console.log(`    ${label.padEnd(13)}${uri}`);
          console.log(`    ${"".padEnd(13)}  → ${expanded ?? "(주소를 못 찾아 아무것도 통과하지 못함)"}`);
        } else {
          const host = hardcodedHost(uri);
          const bad = host !== null && !addresses.includes(host) && host !== "127.0.0.1";
          console.log(`    ${label.padEnd(13)}${uri}${bad ? "   ⚠️ 이 기계의 주소가 아님" : ""}`);
          if (bad) stale.push(`${row.clientId} · ${label} · ${uri}`);
        }
      }
    }
  }

  // ───── 4. 사람이 손대야 하는 것 ─────
  console.log("\n────────────────────────────────────────────");
  if (kakao) {
    console.log("\n⚠️  카카오 개발자 콘솔은 자동으로 맞출 수 없습니다.");
    console.log("    Redirect URI에 아래 값이 그대로 등록되어 있어야 합니다:\n");
    console.log(`      ${kakao}\n`);
    console.log("    주소가 바뀌면 카카오 로그인만 따로 깨집니다. 공유기에서");
    console.log("    이 기계에 DHCP 예약을 걸어 두면 이 등록은 한 번으로 끝납니다.");
  }

  if (stale.length > 0) {
    console.log("\n⚠️  자리표시자를 쓰지 않아 주소가 굳어 있는 등록값:");
    for (const line of stale) console.log(`      ${line}`);
    console.log("\n    호스트를 {lan}으로 바꾸면 주소가 바뀌어도 따라옵니다. 예:");
    console.log("      npm run client:register -- --client-id <id> \\");
    console.log("          --redirect-uri 'http://{lan}:3000/api/auth/sso/callback'");
  } else {
    console.log("\n✅ 모든 등록값이 주소 변경을 따라옵니다.");
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
