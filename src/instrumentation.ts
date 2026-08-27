/**
 * 서버가 요청을 받기 전에 설정을 확인한다.
 *
 * Next는 서버 인스턴스가 뜰 때마다 register()를 한 번 부르고, **이것이 끝나야
 * 요청을 받기 시작한다**(dist/docs 03-file-conventions/instrumentation.md).
 * 여기서 던지면 서버가 뜨지 않는다.
 *
 * 왜 여기여야 하는가 — 실측으로 배운 것:
 *
 * 전송 설정 검사를 getIssuer() 안에만 두었더니, 잘못된 설정으로도 서버가
 * 올라가고 로그인 화면(/signin)까지 멀쩡히 떴다. 그 화면이 issuer 값을 쓰지
 * 않기 때문이다. 실제로 막힌 곳은 discovery처럼 그 값을 쓰는 경로뿐이었고,
 * 브라우저에는 500만 뜨고 이유는 서버 콘솔에만 남았다.
 *
 * 즉 "설정이 틀리면 바로 안다"고 믿었는데, 실제로는 **한동안 정상처럼
 * 보이는** 상태였다 — 이 검사가 막으려던 바로 그 모양이다. 시작 시점으로
 * 옮겨야 "서버가 뜨지 않는다"가 사실이 된다.
 */
export async function register(): Promise<void> {
  // register는 모든 런타임에서 불린다. 이 검사는 Node 서버에서만 의미가 있다.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const issuer = process.env.OIDC_ISSUER;

  // 값이 아예 없는 경우는 여기서 다루지 않는다. env.ts의 required()가 그 값을
  // 처음 쓰는 순간 무엇이 빠졌는지 정확히 알려주고, 무엇보다 `next build`는
  // 실제 환경변수 없이도 돌아야 한다.
  if (!issuer) return;

  const { checkTransportConfig } = await import("./lib/config/transport-check");

  const problem = checkTransportConfig({
    issuer: issuer.replace(/\/+$/, ""),
    httpRedirectUrisAllowed: process.env.OIDC_ALLOW_HTTP_REDIRECT_URIS === "true",
    isProduction: process.env.NODE_ENV === "production",
  });

  if (problem) {
    // 콘솔에도 남긴다. 던진 예외는 화면에 안 보이지만 이 줄은 눈에 띈다.
    console.error("\n[설정 오류] " + problem.message + "\n");
    throw new Error(problem.message);
  }
}
