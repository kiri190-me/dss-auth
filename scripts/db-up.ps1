#Requires -Version 5.1
<#
.SYNOPSIS
    로그인 포털 DB(인증 전용 인스턴스 dss-pg-auth)를 켜고 준비될 때까지 기다린다.

.DESCRIPTION
    `npm run db:up`과 start-sso-work.ps1이 함께 부른다. 켜는 방법이 한 곳에만
    있어야 둘이 어긋나지 않는다 — 2026-09-03에 시작 스크립트만 새 인스턴스로
    옮기고 db:up은 옛 상자에 남아, 이름이 같은 두 명령이 서로 다른 상자를 켰다.

    ── 정의는 여기 없다 ──────────────────────────────────────────────────
    NAS 이식 2단계 리허설(2026-09-03) 뒤로 포털 DB는 dss-pg-auth의 dss_auth에
    있다. 컨테이너의 정의는 dss-deploy\nas\docker-compose.rehearsal.yml 한 곳에만
    있고(NAS 파일을 extends 한다), 이 스크립트는 그것으로 만든 컨테이너를 켜고
    기다릴 뿐이다. 저장소의 docker-compose.yml(옛 dss-auth-postgres-dev)은 은퇴했다.

    ── 없을 때만 만든다 ──────────────────────────────────────────────────
    이미 있으면 docker start로 켠다 — 비밀번호 파일이 필요 없고 볼륨이 그대로
    붙는다. 없으면 리허설 compose로 만든다. 그때 비밀번호는 compose 옆의
    .env.nas에서 오는데, 그 파일이 없으면 빈 비밀번호로 만들어져 재시작 루프에
    빠지므로 먼저 막고 어디를 채우라고 알린다.

    ── 상대를 살피지 않는다 ──────────────────────────────────────────────
    A/S·계측기가 나눠 쓰는 dss-pg-app과 달리 이 인스턴스는 포털만 쓴다. 그래서
    그냥 켜고 그냥 끈다(끄기는 db-down.ps1). 인증 DB를 따로 세운 이유가 그것이다 —
    서명 개인키·카카오 시크릿을 다뤄 업무 DB와 등급이 다르다.

    이미 떠 있으면 아무것도 바꾸지 않고 healthy인지만 확인한다. 몇 번 불러도 된다.

    종료 코드
      0  준비됨
      1  켜지 못함 — Docker가 꺼짐 · 만들 파일이나 .env.nas가 없음 · compose 실패
      2  켰지만 60초 안에 healthy가 되지 않음. 시작 스크립트는 경고만 하고 이어 간다

.EXAMPLE
    npm run db:up
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$RepoRoot    = Split-Path -Parent $PSScriptRoot
$DevRoot     = Split-Path -Parent $RepoRoot
$DbContainer = 'dss-pg-auth'
$DbService   = 'db-auth'     # 리허설 compose 안의 서비스 이름
$DbPort      = 5444
$Database    = 'dss_auth'
$DbCompose   = Join-Path $DevRoot 'dss-deploy\nas\docker-compose.rehearsal.yml'
$DbEnvFile   = Join-Path $DevRoot 'dss-deploy\nas\.env.nas'

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

Write-Step "DB 인스턴스 확인 ($DbContainer)"

# Docker Desktop을 켜 주는 일은 start-sso-work.ps1이 한다. 여기서는 꺼져 있으면
# 알리고 멈춘다 — 그냥 두면 아래 docker ps가 빈 값을 돌려 "컨테이너가 없다"로
# 잘못 읽히고, 있는 컨테이너를 새로 만들려 든다.
if ((Invoke-Native 'docker info --format "{{.ServerVersion}}"').ExitCode -ne 0) {
    Write-Warn2 "Docker 엔진이 꺼져 있습니다. Docker Desktop을 켠 뒤 다시 실행하세요."
    exit 1
}

$exists = (Invoke-Native "docker ps -a --filter name=^/$DbContainer`$ --format `"{{.Names}}`"").Output
if ($exists -ne $DbContainer) {
    # 처음 한 번만 여기로 온다. 비밀번호는 compose 옆의 .env.nas에서 온다 —
    # 없으면 빈 값으로 만들어져 재시작 루프에 빠지므로 미리 막는다.
    if (-not (Test-Path $DbCompose)) {
        Write-Warn2 "인증 DB 인스턴스가 없고 만들 파일도 없습니다: $DbCompose"
        Write-Info "dss-deploy 저장소를 Development\ 아래에 받아 온 뒤 다시 시작하세요."
        exit 1
    }
    if (-not (Test-Path $DbEnvFile)) {
        Write-Warn2 "비밀번호 파일이 없습니다: $DbEnvFile"
        Write-Info "dss-deploy\README.md 1단계 2번대로 .env.nas 를 채운 뒤 다시 시작하세요."
        exit 1
    }
    Write-Info "컨테이너가 없습니다. dss-deploy 의 리허설 compose 로 새로 만듭니다."
    $up = Invoke-Native "docker compose -f `"$DbCompose`" --env-file `"$DbEnvFile`" up -d $DbService"
    if ($up.ExitCode -ne 0) {
        Write-Warn2 "DB를 띄우지 못했습니다."
        $up.Output -split "`n" | ForEach-Object { Write-Info $_ }
        exit 1
    }
} else {
    # 이미 만들어진 컨테이너는 start로 켠다 — 비밀번호 파일이 필요 없고 볼륨이
    # 그대로 붙는다. 이미 떠 있으면 docker start는 아무것도 하지 않는다.
    Invoke-Native "docker start $DbContainer" | Out-Null
}

foreach ($i in 1..30) {
    $state = (Invoke-Native "docker inspect --format ""{{.State.Health.Status}}"" $DbContainer").Output
    if ($state -eq 'healthy') {
        Write-Ok "준비됨 (127.0.0.1:$DbPort · $Database)"
        exit 0
    }
    Start-Sleep -Seconds 2
}
Write-Warn2 "DB가 아직 준비되지 않았습니다. 잠시 뒤 다시 확인하세요."
Write-Info "docker logs $DbContainer --tail 30 으로 원인을 볼 수 있습니다."
exit 2
