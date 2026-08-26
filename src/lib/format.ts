/**
 * 날짜 표기.
 *
 * 서버 시간대(컨테이너는 보통 UTC)가 아니라 한국 시간으로 고정한다.
 * 고정하지 않으면 개발 PC(한국 시간)와 NAS 컨테이너(UTC)에서 같은 기록이
 * 9시간 다르게 보인다.
 */
const DATE_TIME = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatDateTime(value: Date | null): string {
  if (!value) return "—";
  return DATE_TIME.format(value);
}
