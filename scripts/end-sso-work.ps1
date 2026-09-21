#Requires -Version 5.1
<#
.SYNOPSIS
    로그인 포털 작업 종료 — 3100번 서버를 끄고 DB 컨테이너를 세운다.

.DESCRIPTION
    start-sso-work.ps1과 짝이고, A/S 시스템의 end-work.ps1과 같은 순서로 같은
    것을 확인한다. 바탕화면의 "작업 종료"는 이 스크립트와 저쪽 스크립트를
    함께 부른다(..\end-all.ps1).

    ── 왜 DB 백업이 없는가 ─────────────────────────────────────────────────
    A/S 쪽은 끄기 전에 pg_dump를 뜬다. 거기 담긴 수리 접수·고객사는 이 PC에만
    있고 잃으면 되살릴 방법이 없기 때문이다. 이 DB는 다르다. 담긴 것은
    "카카오 회원번호 ↔ 사원 승인 상태"와 클라이언트 등록 정보라서, 잃어도
    직원이 다시 로그인하고 관리자가 다시 승인하면 되돌아온다.

    되살릴 수 없는 것은 오히려 DB 밖에 있다 — `keys\`의 서명 개인키다. 이것이
    사라지면 이미 발급한 토큰이 전부 무효가 되고, 연동한 시스템은 새 키를 받을
    때까지 로그인을 거절한다. 백업을 뜬다면 DB가 아니라 그쪽이다. 지금은
    gitignore 대상이라 이 PC에만 있다.

    ── 안 하는 일 ──────────────────────────────────────────────────────────
    커밋도 푸시도 하지 않는다. 알려만 준다 — 무엇을 남길지는 사람이 정한다.
    컨테이너는 stop만 하고 지우지 않는다. `docker compose down -v`는 볼륨을
    지워 DB를 통째로 날리므로 이 스크립트는 그 명령을 쓰지 않는다.
    Claude Code 창도 건드리지 않는다 — 대화는 서버와 함께 끝나는 것이 아니다.

    ── 대신 멈춘다 ─────────────────────────────────────────────────────────
    안 올린 것이 있으면 알리는 데서 그치지 않고 **끄는 것을 멈춘다.** 서버와
    DB가 켜진 채여서 그 자리에서 바로 커밋하면 된다. 알고도 그대로 끄려면
    -Force.

.PARAMETER Force
    안 올린 것이 있어도 멈추지 않고 끝까지 끈다. 오늘 남긴 것을 알고 있고
    그대로 두기로 정했을 때만.

.PARAMETER DryRun
    무엇을 할지 보여 주기만 하고 실제로는 아무것도 끄지 않는다.

.PARAMETER NoFooter
    마지막 "정리 끝" 인사를 찍지 않는다. 바탕화면 '작업 종료'가 두 스크립트를
    이어 부를 때, 끝인사가 두 번 나오면 어디가 진짜 끝인지 알 수 없다.
    그 자리에서는 ..\..\end-all.ps1이 한 번만 인사한다.

.EXAMPLE
    npm run work:end
    npm run work:end -- -Force
    .\scripts\end-sso-work.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$DryRun,
    [switch]$NoFooter
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$RepoRoot  = Split-Path -Parent $PSScriptRoot
# 포털 DB(인증 전용 인스턴스 dss-pg-auth)를 끄는 방법은 scripts\db-down.ps1 한
# 곳에 있다(4번). 이 인스턴스는 포털만 쓰므로 상대를 살피지 않고 그냥 끈다.
$DevPort   = 3100

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

# 🔴 포트 표(Get-NetTCPConnection)는 CIM을 거쳐 읽는다. 그 길이 한 번 막히면
# -ErrorAction SilentlyContinue가 오류를 삼켜 결과가 빈 목록이 되고, "안 떠
# 있다"와 "못 봤다"가 똑같이 생긴다 — 2026-09-21에 떠 있는 이 포털의 3100을
# "이미 꺼져 있음"이라고 넘어간 적이 있다. 그래서 표가 비었을 때는 소켓을
# 직접 열고 HTTP로 두드려 한 번 더 본다. CIM을 거치지 않는 다른 길이다.
# 살아 있으면 무엇으로 답했는지를 글자로, 죽었으면 $null을 돌려준다.
function Test-StillAlive([int]$Port) {
    $client    = New-Object System.Net.Sockets.TcpClient
    $reachable = $false
    try {
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(800)) { $client.EndConnect($iar); $reachable = $true }
    } catch {
    } finally { $client.Close() }
    if (-not $reachable) { return $null }

    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0 -ErrorAction Stop
        return "HTTP $([int]$r.StatusCode)"
    } catch {
        $resp = $_.Exception.Response
        if ($resp) { return "HTTP $([int]$resp.StatusCode)" }
        return 'TCP 연결됨(HTTP 응답 없음)'
    }
}

Set-Location $RepoRoot
Write-Host ""
Write-Host "════ 로그인 포털 종료 ════" -ForegroundColor White
Write-Host "  $RepoRoot" -ForegroundColor DarkGray
if ($DryRun) { Write-Host "  [연습 모드] 실제로는 아무것도 끄지 않습니다." -ForegroundColor Magenta }

# ── 1. 남긴 것 확인 (먼저 보여 준다 — 끄고 나서 알면 늦다) ────────────────
Write-Step "안 올린 작업 확인"
$dirtyLines = @((Invoke-Native 'git status --porcelain').Output -split "`n" | Where-Object { $_ -ne '' })
$blockers   = @()   # 하나라도 차면 서버를 끄지 않는다

if ($dirtyLines.Count -gt 0) {
    Write-Warn2 "커밋하지 않은 파일 $($dirtyLines.Count)개 — 이 PC에만 있습니다"
    $dirtyLines | Select-Object -First 8 | ForEach-Object { Write-Info $_ }
    if ($dirtyLines.Count -gt 8) { Write-Info "… 외 $($dirtyLines.Count - 8)개" }
    $blockers += "커밋하지 않은 파일 $($dirtyLines.Count)개"
} else {
    Write-Ok "커밋하지 않은 파일 없음"
}

# 이 저장소는 아직 원격이 없다(2026-08-26 기준). 그래서 A/S 쪽처럼 "몇 개를
# 안 올렸나"를 셀 수가 없다 — 전부 안 올린 것이다. 셀 수 없는 것을 위반으로
# 삼으면 매번 문이 잠기므로, 알리기만 하고 지나간다. 잃으면 되돌릴 수 없는
# 자산이라는 사실은 그대로이니 조용히 넘기지도 않는다.
$remotes = @((Invoke-Native 'git remote').Output -split "`n" | Where-Object { $_ -ne '' })
if ($remotes.Count -eq 0) {
    Write-Warn2 "원격 저장소가 없습니다 — 커밋이 전부 이 PC에만 있습니다 (종료는 막지 않습니다)"
} else {
    $unpushed = (Invoke-Native 'git rev-list --count "@{u}..HEAD"').Output
    if ($unpushed -match '^\d+$') {
        if ([int]$unpushed -gt 0) {
            Write-Warn2 "깃허브에 안 올린 커밋 $($unpushed)개 — 이 PC에만 있습니다"
            $blockers += "푸시하지 않은 커밋 $($unpushed)개"
        } else {
            Write-Ok "전부 깃허브에 올라가 있습니다"
        }
    } else {
        Write-Warn2 "업스트림이 없어 푸시 여부를 확인하지 못했습니다 (종료는 막지 않습니다)"
    }
}

# ── 2. 안 올린 것이 있으면 여기서 멈춘다 ──────────────────────────────────
if ($blockers.Count -gt 0) {
    if ($Force) {
        Write-Warn2 "-Force — 안 올린 것이 있지만 그대로 종료합니다 ($($blockers -join ', '))"
    } else {
        Write-Host ""
        Write-Host "════ 종료를 멈췄습니다 ════" -ForegroundColor Yellow
        foreach ($b in $blockers) { Write-Host "  $($b)가 남아 있습니다." -ForegroundColor Yellow }
        Write-Host "  로그인 포털의 서버와 DB는 켜둔 채입니다." -ForegroundColor Gray
        Write-Host "  커밋 후 다시 실행하거나, 그대로 끄려면:" -ForegroundColor Gray
        Write-Host "    npm run work:end -- -Force" -ForegroundColor DarkGray
        Write-Host "    (또는) powershell -File .\scripts\end-sso-work.ps1 -Force" -ForegroundColor DarkGray
        Write-Host ""
        exit 1
    }
}

# ── 3. 개발 서버 ──────────────────────────────────────────────────────────
Write-Step "로그인 포털 서버 종료 ($DevPort)"
$listener = Get-NetTCPConnection -LocalPort $DevPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
    # 🔴 표가 비었다고 꺼진 것이 아니다 (2026-09-22). 실제로 두드려 본다.
    $stillAlive = Test-StillAlive $DevPort
    if ($stillAlive) {
        Write-Warn2 "포트 목록에는 없는데 아직 응답합니다 ($stillAlive) — 끄지 못했습니다."
        Write-Info "손으로 끄려면: netstat -ano -p tcp | findstr :$DevPort  →  taskkill /PID <번호> /F"
    } else {
        Write-Ok "이미 꺼져 있음"
    }
} else {
    $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -notin @('node', 'next-server')) {
        # 3100번을 쓰는 것이 우리 서버가 아니면 건드리지 않는다.
        Write-Warn2 "$DevPort`번 포트를 '$($proc.ProcessName)'이 쓰고 있어 그대로 둡니다."
    } elseif (-not $proc) {
        Write-Warn2 "$DevPort`번을 쓰는 프로세스를 찾지 못했습니다."
    } elseif ($DryRun) {
        Write-Info "종료할 프로세스: $($proc.ProcessName) (PID $($proc.Id))"
    } else {
        Stop-Process -Id $proc.Id -Force
        Write-Ok "종료됨 (PID $($proc.Id))"
    }
}

# ── 4. 컨테이너 정지 (자료는 그대로 남는다) ───────────────────────────────
# 끄는 방법은 db-down.ps1 한 곳에만 있다 — npm run db:down과 같은 것을 부른다.
# 서버를 3번에서 먼저 껐으므로 여기서 DB를 꺼도 끊길 연결이 없다.
# 정지에 실패해도 경고만 보고 끝인사까지 간다(원래 그랬다).
& (Join-Path $PSScriptRoot 'db-down.ps1') -DryRun:$DryRun

if (-not $NoFooter) {
    Write-Host ""
    Write-Host "════ 로그인 포털 정리 끝 ════" -ForegroundColor White
    Write-Host ""
}
