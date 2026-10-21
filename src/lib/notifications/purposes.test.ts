import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_NOTIFICATION_PURPOSE,
  NOTIFICATION_PURPOSES,
  NOTIFICATION_PURPOSE_LABELS,
  diffSubmittedPurposes,
  isNotificationPurpose,
  purposeFieldName,
  purposeOf,
  toNotificationPurpose,
  type NotificationPurpose,
} from "./purposes";
import { KIND_MARKER_FIELD } from "./settings-form";

/** 포털에 저장된 값. 행이 없는 종류는 여기에도 없다. */
function stored(
  entries: [string, NotificationPurpose][] = []
): ReadonlyMap<string, NotificationPurpose> {
  return new Map(entries);
}

/** 화면이 보내는 그대로 — 줄마다 표시 하나, 고르개 하나. */
function form(params: {
  onScreen: string[];
  chose?: [string, string][];
}): FormData {
  const data = new FormData();
  for (const value of params.onScreen) data.append(KIND_MARKER_FIELD, value);
  for (const [kind, purpose] of params.chose ?? []) {
    data.append(purposeFieldName(kind), purpose);
  }
  return data;
}

// ───────────────────────────────────────────── 기본값과 모르는 글자

test("🔴 행이 없으면 승인용이다 — 모르면 남긴다", () => {
  // 잘못 「정보 확인용」으로 보면 확인하는 순간 영영 사라져 사람이 결재를
  // 놓치고, 놓쳤다는 사실을 아무도 모른다. 반대 실수는 거슬릴 뿐이다.
  assert.equal(DEFAULT_NOTIFICATION_PURPOSE, "ACTION");
  assert.equal(purposeOf(stored(), "REPAIR_CASE_APPROVAL"), "ACTION");
});

test("저장된 행이 있으면 그 값이다", () => {
  assert.equal(purposeOf(stored([["NOTICE", "INFO"]]), "NOTICE"), "INFO");
  assert.equal(purposeOf(stored([["NOTICE", "INFO"]]), "다른종류"), "ACTION");
});

test("🔴 모르는 글자는 승인용으로 떨어진다 — DB 에 CHECK 를 안 건 근거", () => {
  assert.equal(toNotificationPurpose("REVIEW"), "ACTION");
  assert.equal(toNotificationPurpose(""), "ACTION");
  assert.equal(toNotificationPurpose(null), "ACTION");
  assert.equal(toNotificationPurpose(undefined), "ACTION");
  assert.equal(toNotificationPurpose(7), "ACTION");
  // 아는 글자는 그대로 둔다.
  assert.equal(toNotificationPurpose("INFO"), "INFO");
  assert.equal(toNotificationPurpose("ACTION"), "ACTION");
});

test("아는 글자는 둘뿐이고, 작은 차이도 아는 글자가 아니다", () => {
  assert.deepEqual([...NOTIFICATION_PURPOSES], ["INFO", "ACTION"]);
  assert.equal(isNotificationPurpose("info"), false);
  assert.equal(isNotificationPurpose(" ACTION"), false);
});

test("🔴 화면에 그릴 글자는 쓰는 분이 고른 말 그대로다", () => {
  assert.equal(NOTIFICATION_PURPOSE_LABELS.INFO, "정보 확인용");
  assert.equal(NOTIFICATION_PURPOSE_LABELS.ACTION, "승인용");
});

test("폼 칸 이름은 종류마다 다르다", () => {
  assert.equal(purposeFieldName("REPAIR_CASE_APPROVAL"), "purpose:REPAIR_CASE_APPROVAL");
  assert.notEqual(purposeFieldName("A"), purposeFieldName("B"));
});

// ───────────────────────────────────────────── 바뀐 분류만 고른다

test("안 바뀐 종류는 뽑히지 않는다", () => {
  const changes = diffSubmittedPurposes({
    form: form({ onScreen: ["A", "B"], chose: [["A", "INFO"], ["B", "ACTION"]] }),
    kinds: [{ kind: "A" }, { kind: "B" }],
    // B 는 행이 없다 = 기본값 ACTION. 고른 값도 ACTION 이라 바뀐 것이 없다.
    stored: stored([["A", "INFO"]]),
  });
  assert.deepEqual(changes, []);
});

test("기본값(행 없음)에서 정보 확인용으로 바꾸면 뽑힌다", () => {
  const changes = diffSubmittedPurposes({
    form: form({ onScreen: ["A"], chose: [["A", "INFO"]] }),
    kinds: [{ kind: "A" }],
    stored: stored(),
  });
  assert.deepEqual(changes, [{ kind: "A", purpose: "INFO" }]);
});

test("정보 확인용에서 승인용으로 되돌리는 것도 바뀐 것이다", () => {
  const changes = diffSubmittedPurposes({
    form: form({ onScreen: ["A"], chose: [["A", "ACTION"]] }),
    kinds: [{ kind: "A" }],
    stored: stored([["A", "INFO"]]),
  });
  assert.deepEqual(changes, [{ kind: "A", purpose: "ACTION" }]);
});

test("둘 다 바뀌었으면 둘 다 뽑힌다 — 차례는 그 시스템이 보낸 차례다", () => {
  const changes = diffSubmittedPurposes({
    form: form({
      onScreen: ["A", "B", "C"],
      chose: [["A", "INFO"], ["B", "ACTION"], ["C", "INFO"]],
    }),
    kinds: [{ kind: "A" }, { kind: "B" }, { kind: "C" }],
    // B 만 그대로다.
    stored: stored([["B", "ACTION"], ["C", "ACTION"]]),
  });
  assert.deepEqual(changes, [
    { kind: "A", purpose: "INFO" },
    { kind: "C", purpose: "INFO" },
  ]);
});

test("🔴 화면에 없던 종류는 건드리지 않는다 — 화면을 연 뒤 저쪽이 늘린 줄", () => {
  // 표시(KIND_MARKER_FIELD)가 안 실린 종류는 사람이 뜻을 정한 적이 없다.
  // 고르개 값이 실려 와도 마찬가지다 — 손으로 지어 보낸 요청이다.
  const changes = diffSubmittedPurposes({
    form: form({ onScreen: ["A"], chose: [["A", "ACTION"], ["새로생긴것", "INFO"]] }),
    kinds: [{ kind: "A" }, { kind: "새로생긴것" }],
    stored: stored(),
  });
  assert.deepEqual(changes, []);
});

test("🔴 칸이 아예 안 실린 종류는 무시한다 — 기본값을 저장해 행을 만들지 않는다", () => {
  const changes = diffSubmittedPurposes({
    form: form({ onScreen: ["A"] }),
    kinds: [{ kind: "A" }],
    // 저장된 값이 INFO 인데 고르개가 안 실렸다. 기본값(ACTION)으로 읽으면
    // 사람이 정해 둔 INFO 가 조용히 덮인다.
    stored: stored([["A", "INFO"]]),
  });
  assert.deepEqual(changes, []);
});

test("🔴 모르는 글자가 올라오면 무시한다 — 저장도 기본값으로 떨어뜨리지도 않는다", () => {
  const changes = diffSubmittedPurposes({
    form: form({ onScreen: ["A"], chose: [["A", "REVIEW"]] }),
    kinds: [{ kind: "A" }],
    stored: stored([["A", "INFO"]]),
  });
  assert.deepEqual(changes, []);
});

test("그 시스템이 내주지 않는 종류는 쳐다보지 않는다", () => {
  // 표시도 고르개도 실려 왔지만 저쪽 목록에 없다. 포털이 모르는 종류의 분류를
  // 만들어 내면 그 행은 영영 화면에 안 나오고 지울 길도 없다.
  const changes = diffSubmittedPurposes({
    form: form({ onScreen: ["없는종류"], chose: [["없는종류", "INFO"]] }),
    kinds: [{ kind: "A" }],
    stored: stored(),
  });
  assert.deepEqual(changes, []);
});

test("Object 가 가진 이름과 같은 종류 코드도 칸으로 착각하지 않는다", () => {
  // 종류 코드는 저쪽이 보낸 글자다. 평범한 객체로 들고 있었으면 `toString` 이
  // 늘 「저장된 값이 있다」가 된다 — Map 으로 들고 있는 까닭이다.
  const changes = diffSubmittedPurposes({
    form: form({ onScreen: ["toString"], chose: [["toString", "ACTION"]] }),
    kinds: [{ kind: "toString" }],
    stored: stored(),
  });
  // 저장된 값이 없으니 기본값 ACTION, 고른 값도 ACTION → 바뀐 것이 없다.
  assert.deepEqual(changes, []);
});

// ───────────────────────── 화면 ↔ 저장 사이의 약속 (코드를 읽어 못 박는다)

test("🔴 분류 고르개는 잠기지 않는다 — 잠긴 시스템에서도 고칠 수 있는 것이 이 칸의 이득", () => {
  const source = readFileSync("src/app/admin/notifications/page.tsx", "utf8");

  const start = source.indexOf("purposeFieldName(row.kind)");
  assert.ok(start > 0, "분류 고르개가 화면에서 사라졌다");
  const end = source.indexOf("</select>", start);
  assert.ok(end > start, "분류 고르개의 끝을 찾을 수 없다");

  // 역할 칸의 `disabled={!role.editable || shown.rolesLocked}` 를 따라 하면
  // 이 값까지 저쪽 설정에 묶여, 넷은 영영 분류를 못 고치게 된다.
  assert.ok(
    !source.slice(start, end).includes("disabled"),
    "분류 고르개가 잠겼다"
  );
});

test("🔴 분류를 포털에 저장한 뒤에 그 시스템으로 보낸다", () => {
  const source = readFileSync("src/lib/server/actions/notification-settings.ts", "utf8");

  const portal = source.indexOf("await saveKindPurposes(");
  const remote = source.indexOf("await saveNotificationSettings(");
  assert.ok(portal > 0, "분류 저장이 사라졌다");
  assert.ok(remote > 0, "시스템 전송이 사라졌다");
  // 뒤집으면 「저쪽에는 보냈는데 포털 쓰기가 깨진」 반쪽 상태가 생기고, 그 상태는
  // 사람에게 설명할 말이 없다.
  assert.ok(portal < remote, "분류 저장이 시스템 전송보다 뒤로 밀렸다");
});

test("🔴 저장 액션의 인가는 분류에도 걸린다 — 맨 앞에서 한 번 본다", () => {
  const source = readFileSync("src/lib/server/actions/notification-settings.ts", "utf8");

  assert.ok(
    source.includes("const admin = await assertPortalAdmin();"),
    "저장 액션이 포털 관리자 확인을 하지 않는다"
  );
  assert.ok(
    source.indexOf("assertPortalAdmin()") < source.indexOf("await saveKindPurposes("),
    "권한 확인이 분류 저장보다 뒤로 밀렸다"
  );
});
