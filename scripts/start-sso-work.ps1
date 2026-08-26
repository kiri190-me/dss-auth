#Requires -Version 5.1
<#
.SYNOPSIS
    통합 로그인(SSO) 작업 시작 — dss-auth와 A/S 관리 시스템을 함께 편다.

.DESCRIPTION
    RF_Service_System의 start-work.ps1과 같은 철학이다. 다만 이쪽은
    **저장소가 둘**이라 한쪽만 띄우면 로그인 왕복을 확인할 수 없다.

    창이 넷으로 나뉜다. 한 창에 다 넣으면 두 서버의 로그와 대화가 뒤섞여
    넷 다 읽기 어려워진다.

      이 창              dss-auth 개발 서버 (3100)
      두 번째 창          A/S 관리 시스템 스택 (3000)
      세 번째 창          Claude Code — 로그인 포털 (dss-auth)
      네 번째 창          Claude Code — A/S 관리 시스템

    ── Claude를 저장소마다 따로 띄우는 이유 ──────────────────────────────
    Claude는 자기가 켜진 폴더를 작업 폴더로 삼는다. 한 창으로 두 저장소를
    오가면 그 창의 지시서·기록·슬래시 명령이 반대쪽 저장소 것과 섞인다.
    저장소마다 한 창씩 두면 각자 제 자리에서 /로그인작업시작, /작업시작을
    그대로 쓸 수 있다.

    ── Wi-Fi 주소를 확인하는 이유 ────────────────────────────────────────
    카카오는 Redirect URI를 문자 단위로 대조한다. 사무실 Wi-Fi가 바뀌면
    .env.local과 카카오 개발자 콘솔 양쪽을 고쳐야 하는데, 안 고치면
    로그인 버튼을 누른 뒤에야 KOE006으로 막힌다. 그래서 시작할 때 미리 본다.

    ── 마이그레이션을 자동 적용하지 않는 이유 ──────────────────────────
    RF쪽과 같다. 적용 대기가 있으면 알려만 준다. 아침에 창 하나 열었을 뿐인데
    표가 사라져 있으면 안 된다.

.PARAMETER WithClaude
    Claude Code를 별도 창으로 띄운다. 바탕화면 단축어는 이걸 켜서 부른다.

.PARAMETER NoServer
    서버는 띄우지 않고 상태 확인까지만 한다.

.PARAMETER SkipAsSystem
    A/S 관리 시스템은 띄우지 않는다. dss-auth만 손볼 때 쓴다.

.EXAMPLE
    .\scripts\start-sso-work.ps1 -WithClaude
#>
[CmdletBinding()]
param(
    [switch]$WithClaude,
    [switch]$NoServer,
    [switch]$SkipAsSystem
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$RepoRoot      = Split-Path -Parent $PSScriptRoot
$DevRoot       = Split-Path -Parent $RepoRoot
$AsRepo        = Join-Path $DevRoot 'RF_Service_System'
$AsStarter     = Join-Path $AsRepo 'scripts\start-work.ps1'
$Container     = 'dss-auth-postgres-dev'
$DevUrl        = 'http://localhost:3100'
$EnvFile       = Join-Path $RepoRoot '.env.local'
$DockerDesktop = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'

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

Set-Location $RepoRoot
Write-Host ""
Write-Host "════ 통합 로그인 작업 시작 ════" -ForegroundColor White
Write-Host "  $RepoRoot" -ForegroundColor DarkGray

# ── 1. Docker 엔진 ────────────────────────────────────────────────────────
Write-Step "Docker 엔진 확인"
if ((Invoke-Native 'docker info --format "{{.ServerVersion}}"').ExitCode -ne 0) {
    if (Test-Path $DockerDesktop) {
        Write-Info "Docker Desktop을 켜는 중… (처음이면 1분 정도)"
        Start-Process $DockerDesktop | Out-Null
        $ready = $false
        foreach ($i in 1..90) {
            Start-Sleep -Seconds 2
            if ((Invoke-Native 'docker info --format "{{.ServerVersion}}"').ExitCode -eq 0) { $ready = $true; break }
        }
        if (-not $ready) {
            Write-Warn2 "Docker가 아직 준비되지 않았습니다. 켜진 뒤 다시 실행하세요."
            exit 1
        }
    } else {
        Write-Warn2 "Docker Desktop을 찾을 수 없습니다."
        exit 1
    }
}
Write-Ok "실행 중"

# ── 2. dss-auth 데이터베이스 ──────────────────────────────────────────────
Write-Step "로그인 포털 DB 확인"
# docker compose를 직접 부르지 않는다. compose는 .env만 자동으로 읽고
# .env.local은 읽지 않아, 비밀번호가 빈 값으로 들어가 재시작 루프에 빠진다.
# db:up 스크립트가 --env-file을 붙여 준다.
$up = Invoke-Native 'npm run --silent db:up'
if ($up.ExitCode -ne 0) {
    Write-Warn2 "DB를 띄우지 못했습니다."
    $up.Output -split "`n" | ForEach-Object { Write-Info $_ }
    exit 1
}

$healthy = $false
foreach ($i in 1..30) {
    $state = (Invoke-Native "docker inspect --format ""{{.State.Health.Status}}"" $Container").Output
    if ($state -eq 'healthy') { $healthy = $true; break }
    Start-Sleep -Seconds 2
}
if ($healthy) {
    Write-Ok "준비됨 (127.0.0.1:5434)"
} else {
    Write-Warn2 "DB가 아직 준비되지 않았습니다. 잠시 뒤 다시 확인하세요."
}

# ── 3. 접속 주소 점검 ─────────────────────────────────────────────────────
# 이 프로젝트에서 가장 자주 시간을 잡아먹는 지점이다.
Write-Step "접속 주소 점검"

$configured = $null
if (Test-Path $EnvFile) {
    foreach ($line in (Get-Content $EnvFile)) {
        if ($line -match '^OIDC_ISSUER=(.+)$') { $configured = $Matches[1].Trim(); break }
    }
}

if (-not $configured) {
    Write-Warn2 ".env.local에 OIDC_ISSUER가 없습니다."
} else {
    $configuredHost = $null
    if ($configured -match '://([^:/]+)') { $configuredHost = $Matches[1] }

    $wifi = $null
    try {
        $wifi = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Where-Object { $_.InterfaceAlias -like 'Wi-Fi*' -and $_.PrefixOrigin -eq 'Dhcp' } |
                Select-Object -First 1 -ExpandProperty IPAddress
    } catch {}

    Write-Info "설정된 주소   $configured"
    if ($wifi) { Write-Info "현재 Wi-Fi    $wifi" }

    if ($configuredHost -eq 'localhost' -or $configuredHost -eq '127.0.0.1') {
        Write-Ok "이 PC에서만 쓰는 설정입니다"
        Write-Info "폰이나 동료 PC에서 열려면 Wi-Fi 주소로 바꿔야 합니다."
    }
    elseif ($configuredHost -match '^\d+\.\d+\.\d+\.\d+$') {
        if ($wifi -and $configuredHost -ne $wifi) {
            Write-Host ""
            Write-Warn2 "Wi-Fi 주소가 바뀌었습니다. 이대로면 카카오가 KOE006으로 막습니다."
            Write-Host ""
            Write-Info "고칠 곳 넷 — 하나라도 빠지면 로그인이 안 됩니다:"
            Write-Info "  1. dss-auth\.env.local  OIDC_ISSUER=http://$wifi`:3100"
            Write-Info "  2. dss-auth\.env.local  KAKAO_REDIRECT_URI=http://$wifi`:3100/api/kakao/callback"
            Write-Info "  3. 카카오 콘솔  앱 설정 → 플랫폼 → Web → 사이트 도메인"
            Write-Info "  4. 카카오 콘솔  제품 설정 → 카카오 로그인 → Redirect URI"
            Write-Info "     (바로 아래 '로그아웃 리다이렉트 URI'와 다른 칸입니다)"
            Write-Host ""
            Write-Info "A/S 시스템을 연동한 뒤라면 그쪽 .env.local의 SSO_ISSUER,"
            Write-Info "SSO_REDIRECT_URI와 dss-auth의 클라이언트 등록 주소도 함께 고칩니다."
            Write-Host ""
        } elseif ($wifi) {
            Write-Ok "현재 Wi-Fi 주소와 일치합니다"
        } else {
            Write-Warn2 "Wi-Fi 주소를 읽지 못했습니다. 직접 확인하세요."
        }
    }
}

# ── 4. 서명 키 ────────────────────────────────────────────────────────────
Write-Step "서명 키 확인"
$keyDir = Join-Path $RepoRoot 'keys'
$publicKeys = @()
if (Test-Path $keyDir) { $publicKeys = @(Get-ChildItem -Path $keyDir -Filter '*.public.json' -ErrorAction SilentlyContinue) }
if ($publicKeys.Count -eq 0) {
    Write-Warn2 "서명 키가 없습니다. 통합 로그인 발급이 동작하지 않습니다."
    Write-Info "만들기: npm run key:generate"
} else {
    Write-Ok "공개키 $($publicKeys.Count)개"
    if ($publicKeys.Count -gt 1) { Write-Info "키 교체 중인 상태입니다(옛 키가 남아 있음)." }
}

# ── 5. 적용 대기 마이그레이션 (알림만) ────────────────────────────────────
Write-Step "저장소 상태"
$branch = (Invoke-Native 'git rev-parse --abbrev-ref HEAD').Output
$dirty  = @((Invoke-Native 'git status --porcelain').Output -split "`n" | Where-Object { $_ -ne '' }).Count
Write-Info "브랜치       $branch"
if ($dirty -gt 0) { Write-Warn2 "커밋 안 된 파일 $($dirty)개" } else { Write-Ok "정리된 상태" }

if (-not $SkipAsSystem -and (Test-Path $AsRepo)) {
    $asDirty = @((Invoke-Native "git -C ""$AsRepo"" status --porcelain").Output -split "`n" | Where-Object { $_ -ne '' }).Count
    if ($asDirty -gt 0) { Write-Warn2 "A/S 시스템에도 커밋 안 된 파일 $($asDirty)개" }
}

if ($NoServer) {
    Write-Host ""
    Write-Host "준비 완료 (서버는 띄우지 않음). 띄우려면: npm run dev" -ForegroundColor White
    exit 0
}

# ── 6. A/S 관리 시스템 (별도 창) ──────────────────────────────────────────
# 로그인 왕복을 보려면 두 서버가 동시에 떠 있어야 한다. 저쪽은 Docker 확인부터
# 상태 점검까지 자기 스크립트가 이미 잘 하고 있으므로 그대로 부른다.
# Claude도 저쪽 스크립트에 맡긴다 — 그래야 A/S 저장소를 작업 폴더로 잡는다.
if (-not $SkipAsSystem) {
    Write-Step "A/S 관리 시스템 시작"
    if (Test-Path $AsStarter) {
        $asArgs = if ($WithClaude) { ' -WithClaude' } else { '' }
        Start-Process cmd -ArgumentList '/c', "title A-S 관리 시스템 - 서버 && cd /d `"$AsRepo`" && powershell -NoProfile -ExecutionPolicy Bypass -File `"$AsStarter`"$asArgs" | Out-Null
        Write-Ok "별도 창에서 실행 중 (http://localhost:3000)"
        # 저쪽 Claude는 Docker·DB 점검을 마친 뒤에 뜬다. 몇십 초 늦게 나타나도
        # 빠진 것이 아니다.
        if ($WithClaude) { Write-Info "그 창의 점검이 끝나면 A/S용 Claude 창이 따로 뜹니다." }
    } else {
        Write-Warn2 "A/S 시스템 시작 스크립트를 찾을 수 없습니다: $AsStarter"
    }
}

# ── 7. Claude Code — 로그인 포털용 (선택) ────────────────────────────────
# A/S 저장소용 Claude는 6번에서 저쪽 스크립트가 자기 폴더에서 띄운다.
if ($WithClaude) {
    Write-Step "Claude Code 실행 (로그인 포털)"
    $claude = (Get-Command claude -ErrorAction SilentlyContinue)
    if (-not $claude) {
        Write-Warn2 "claude 명령을 찾을 수 없어 건너뜁니다."
        Write-Info "설치: npm install -g @anthropic-ai/claude-code"
    } else {
        Start-Process cmd -ArgumentList '/c', "title Claude - DSS 통합 로그인 && cd /d `"$RepoRoot`" && claude" | Out-Null
        Write-Ok "별도 창에서 실행 중"
        Write-Info "이 창(Claude - DSS 통합 로그인)에서 /로그인작업시작"
        if (-not $SkipAsSystem) {
            Write-Info "A/S 창(Claude - RF_Service_System)에서는 /작업시작"
        }
    }
}

# ── 8. dss-auth 개발 서버 ─────────────────────────────────────────────────
Write-Step "로그인 포털 서버 시작"
Write-Info "$DevUrl — 이 창을 닫으면 서버도 꺼집니다."
Write-Host ""

# 서버가 실제로 응답하면 그때 브라우저를 연다. 컴파일 전에 열면 빈 화면을 본다.
$waiter = @"
foreach (`$i in 1..120) {
    Start-Sleep -Seconds 1
    try {
        Invoke-WebRequest -Uri '$DevUrl' -UseBasicParsing -TimeoutSec 2 | Out-Null
        Start-Process '$DevUrl'
        break
    } catch {}
}
"@
Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', $waiter | Out-Null

& npm run dev
