/**
 * 회사 로고의 표식 — 파랑·흰색·빨강 정사각형 셋을 세로로 쌓은 것.
 *
 * ■ 왜 SVG로 그리는가
 *
 * public/icons/ 에 이미 같은 표식의 PNG가 넷 있지만 그것들은 홈 화면
 * 아이콘이다. 화면에 쓰면 크기가 고정이라 고해상도 화면에서 뭉개지고,
 * 흰 바탕이 구워져 있어 배경 위에 사각형으로 뜬다. 그릴 것이 사각형
 * 셋뿐이라 SVG가 훨씬 정확하고, 파일 요청도 늘지 않는다.
 *
 * ■ 치수는 scripts/generate-icons.ts 와 같은 값이다
 *
 * 간격은 한 변의 9%, 가운데 칸 테두리는 한 변의 5.5%. 그쪽 값을 고치면
 * 여기도 함께 고쳐야 두 곳의 표식이 어긋나지 않는다. 홈 화면 아이콘과
 * 로그인 화면이 같은 모양이어야 사용자가 같은 것으로 알아본다.
 *
 * ■ 왜 흰 판 위에 두는가
 *
 * 로고의 파랑은 #0000CC다. 다크 모드 배경 #09090b 위에서는 거의 검정과
 * 구분되지 않아 사각형 셋 중 하나가 사라진다. 그렇다고 다크 모드용 파랑을
 * 새로 지어내면 그건 더 이상 회사 로고가 아니다.
 *
 * 대신 로고를 원래 놓이던 자리에 둔다 — 흰 바탕이다. generate-icons.ts도
 * 캔버스를 흰색으로 채우고 그 위에 그린다. 밝은 화면에서는 판이 배경에
 * 녹아 표식만 보이고, 어두운 화면에서는 홈 화면 아이콘과 같은 흰 타일이
 * 된다. 브랜드 색을 한 번도 건드리지 않고 양쪽을 해결한다.
 */

/** 로고 색. generate-icons.ts와 같은 값이다. */
const BLUE = "#0000CC";
const RED = "#EE0000";
const BORDER = "#A8A8A8";

/**
 * 한 변을 100으로 두면 간격은 9, 전체 높이는 100×3 + 9×2 = 318이 된다.
 *
 * 가운데 칸 테두리만은 비율이 아니라 **화면 픽셀로 고정한다**
 * (non-scaling-stroke). 아이콘을 그리는 generate-icons.ts는 한 변의 5.5%를
 * 쓰지만 그건 192px·512px에서 그릴 때의 이야기다. 화면에서는 표식이 46px밖에
 * 안 되어 5.5 × 46/318 ≈ 0.8px가 되고, 서브픽셀이라 브라우저가 거의 칠하지
 * 않는다. 흰 칸은 흰 판에 묻히므로 테두리가 흐려지면 칸 자체가 사라져
 * 로고가 사각형 셋이 아니라 둘로 보인다(dss-home에서 실제로 그랬다).
 */
const STROKE_PX = 1.25;

/*
 * 링은 밝은 화면에서만 쓴다. 거기서는 흰 판이 흰 배경에 녹아 판의 경계가
 * 사라지므로 가는 테두리가 형태를 잡아 준다. 어두운 화면에서는 흰 판이 이미
 * 최대 대비라 링이 할 일이 없고, 오히려 흰 타일 둘레에 어두운 선이 덧그어져
 * 가장자리가 지저분해진다.
 */
export default function DssLogo() {
  return (
    <span className="inline-flex h-14 w-14 items-center justify-center rounded-xl bg-white ring-1 ring-zinc-200 dark:ring-0">
      {/*
        표식은 장식이다 — 바로 옆 h1이 "DSS"라고 이미 말하고 있으므로
        읽는 도구에는 숨긴다. 여기에 alt를 달면 "DSS DSS"로 두 번 읽힌다.
      */}
      <svg
        viewBox="0 0 100 318"
        className="h-[46px] w-auto"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="0" y="0" width="100" height="100" fill={BLUE} />
        {/* 세 칸을 똑같은 100×100으로 두고 가운데에만 선을 얹는다. */}
        <rect
          x="0"
          y="109"
          width="100"
          height="100"
          fill="#FFFFFF"
          stroke={BORDER}
          strokeWidth={STROKE_PX}
          vectorEffect="non-scaling-stroke"
        />
        <rect x="0" y="218" width="100" height="100" fill={RED} />
      </svg>
    </span>
  );
}
