#Requires -Version 5.1
<#
.SYNOPSIS
    로그인 포털 DB(인증 전용 인스턴스 dss-pg-auth)를 멈춘다. 지우지는 않는다.

.DESCRIPTION
    `npm run db:down`과 end-sso-work.ps1이 함께 부른다. 켜기(db-up.ps1)와 짝이다.
    끄는 방법이 한 곳에만 있어야 둘이 어긋나지 않는다.

    NAS 이식 2단계 리허설(2026-09-03) 뒤로 포털 DB는 dss-pg-auth의 dss_auth에 있다.
    이 인스턴스는 포털만 쓴다 — A/S·계측기가 나눠 쓰는 dss-pg-app처럼 상대 서버가
    아직 떠 있는지 살필 것이 없어서 그냥 끈다. 옛 dss-auth-postgres-dev는 정지된 채
    dss-deploy Phase 7(2026-09-17 이후)까지 되돌리기용으로만 남는다. 이 스크립트는
    그것을 건드리지 않는다.

    ⚠️ 이 스크립트는 3100번 개발 서버를 보지 않는다. 서버나 check:oidc가 붙어 있는
    채로 부르면 그쪽 연결이 끊긴다. 서버부터 순서대로 끄려면 npm run work:end.

    stop만 한다. docker rm도 docker compose down도 쓰지 않는다 — compose down은
    컨테이너를 지우고, -v가 붙으면 볼륨(DB 전체)까지 지운다.

    종료 코드
      0  정지됨 · 이미 꺼져 있음 · 연습 모드
      1  docker stop 실패. 종료 스크립트는 경고만 보고 끝인사까지 간다

.PARAMETER DryRun
    무엇을 할지 보여 주기만 하고 실제로는 끄지 않는다.

.EXAMPLE
    npm run db:down
    npm run db:down -- -DryRun
#>
[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Container = 'dss-pg-auth'

# 네이티브 명령은 cmd를 거쳐 부른다. Windows PowerShell 5.1은 exe의 stderr를
# ErrorRecord로 감싸면서 성공한 명령도 실패로 보이게 만들기 때문이다.
function Invoke-Native([string]$CommandLine) {
    $out = & cmd.exe /c "$CommandLine 2>&1"
    [pscustomobject]@{ Output = ($out -join "`n").Trim(); ExitCode = $LASTEXITCODE }
}

function Write-Step([string]$Text)  { Write-Host ""; Write-Host "▶ $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text)    { Write-Host "  ✔ $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "  ⚠ $Text" -ForegroundColor Yellow }
function Write-Info([string]$Text)  { Write-Host "    $Text" -ForegroundColor DarkGray }

Write-Step "로그인 포털 DB 컨테이너 정지"
$running = (Invoke-Native "docker ps --filter name=^/$Container`$ --format `"{{.Names}}`"").Output
if ($running -ne $Container) {
    Write-Ok "이미 꺼져 있음"
    exit 0
}
if ($DryRun) {
    Write-Info "실행할 명령: docker stop $Container"
    exit 0
}
$stop = Invoke-Native "docker stop $Container"
if ($stop.ExitCode -eq 0) {
    Write-Ok "정지됨 — 자료는 볼륨에 그대로 남아 있습니다"
    exit 0
}
Write-Warn2 "정지 실패:"; Write-Host $stop.Output
exit 1
