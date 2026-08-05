[CmdletBinding()]
param(
    [string]$Version = "0.1.0-local",
    [string]$Channel = "dev",
    [string]$OutDir = "",
    [switch]$SkipSmoke,
    [switch]$NoPackage
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $Root "dist/cli-local"
} elseif (-not [IO.Path]::IsPathRooted($OutDir)) {
    $OutDir = Join-Path $Root $OutDir
}

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

function Invoke-ContextDeskJson {
    param([string]$Binary, [string[]]$Arguments, [string]$Label, [string]$TempRoot)
    $stderrPath = Join-Path $TempRoot ("{0}.stderr.txt" -f $Label)
    $stdout = & $Binary @Arguments 2> $stderrPath
    if ($LASTEXITCODE -ne 0) {
        $stderrText = if (Test-Path $stderrPath) { Get-Content -Raw $stderrPath } else { "" }
        throw "$Label failed with exit code $LASTEXITCODE`n$stderrText"
    }
    $raw = ($stdout -join [Environment]::NewLine)
    try { return $raw | ConvertFrom-Json }
    catch {
        $stderrText = if (Test-Path $stderrPath) { Get-Content -Raw $stderrPath } else { "" }
        throw "$Label returned invalid JSON`nstdout: $raw`nstderr: $stderrText"
    }
}

function Resolve-Python {
    foreach ($candidate in @("python3", "python")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($null -ne $command) { return @{ Command = $command.Source; Prefix = @() } }
    }
    $launcher = Get-Command "py" -ErrorAction SilentlyContinue
    if ($null -ne $launcher) { return @{ Command = $launcher.Source; Prefix = @("-3") } }
    throw "Python 3 is required to create the ZIP. Install Python or use -NoPackage."
}

Push-Location $Root
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("contextdesk-cli-build-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TempRoot | Out-Null
try {
    $GitSha = ((& git rev-parse HEAD) -join "").Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($GitSha)) { throw "Unable to resolve the Git commit." }
    $GitDescribe = ((& git describe --always --dirty --tags) -join "").Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($GitDescribe)) { throw "Unable to describe the Git commit." }
    $HostLine = (& rustc -vV | Select-String '^host:').Line
    if ([string]::IsNullOrWhiteSpace($HostLine)) { throw "Unable to determine the Rust host target." }
    $Triple = $HostLine.Substring(5).Trim()
    $Platform = switch ($Triple) {
        "x86_64-pc-windows-msvc" { "windows-x64" }
        "x86_64-pc-windows-gnu" { "windows-x64" }
        "aarch64-apple-darwin" { "macos-arm64" }
        "x86_64-apple-darwin" { "macos-x64" }
        "x86_64-unknown-linux-gnu" { "linux-x64" }
        default { throw "Unsupported local release target: $Triple" }
    }

    $env:CD_GIT_SHA = $GitSha
    $env:CD_GIT_DESCRIBE = $GitDescribe
    $env:CD_CHANNEL = $Channel
    Write-Host "Building ContextDesk CLI $Version for $Platform at $GitDescribe"
    Invoke-Checked "cargo" @("build", "-p", "cd-cli", "--release", "--locked")

    $BinaryName = if ($Platform -eq "windows-x64") { "contextdesk.exe" } else { "contextdesk" }
    $Binary = Join-Path $Root ("target/release/{0}" -f $BinaryName)
    if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { throw "Build did not produce $Binary" }
    Invoke-Checked $Binary @("--version")

    if (-not $SkipSmoke) {
        $Demo = Join-Path $Root "fixtures/cli-release-demo"
        $DataDir = Join-Path $TempRoot "data"
        $Normalized = Join-Path $TempRoot "normalized"
        $Capabilities = Invoke-ContextDeskJson $Binary @("--json", "capabilities") "capabilities" $TempRoot
        if (-not $Capabilities.ok -or -not ($Capabilities.data.commands -contains "normalize")) { throw "Capabilities omitted normalize." }
        if (-not $GitSha.StartsWith([string]$Capabilities.data.git_sha)) { throw "Binary Git identity does not match the checkout." }

        $Import = Invoke-ContextDeskJson $Binary @("--data-dir", $DataDir, "--json", "import", $Demo) "import" $TempRoot
        if (-not $Import.ok -or [int64]$Import.data.events_imported -le 0) { throw "Synthetic import produced no events." }
        $Explore = Invoke-ContextDeskJson $Binary @("--data-dir", $DataDir, "--json", "explore", "error", "--corpus", [string]$Import.data.corpus_id) "explore" $TempRoot
        if (-not $Explore.ok) { throw "Synthetic explore failed." }

        $Normalize = Invoke-ContextDeskJson $Binary @("--json", "normalize", $Demo, "--output", $Normalized, "--output-format", "jsonl") "normalize" $TempRoot
        if (-not $Normalize.ok -or [int64]$Normalize.data.events -le 0) { throw "Synthetic normalization produced no events." }
        $ManifestPath = Join-Path $Normalized "manifest.json"
        $ReportPath = Join-Path $Normalized "normalization-report.json"
        if (-not (Test-Path $ManifestPath) -or -not (Test-Path $ReportPath)) { throw "Normalization omitted its manifest or report." }
        $Manifest = Get-Content -Raw $ManifestPath | ConvertFrom-Json
        $Report = Get-Content -Raw $ReportPath | ConvertFrom-Json
        if ($Manifest.schemaId -ne "contextdesk.normalization_manifest.v1" -or $Report.schemaId -ne "contextdesk.normalization_report.v1") { throw "Unexpected normalization schema." }
        if ([int64]$Report.events -ne [int64]$Normalize.data.events) { throw "CLI and report event counts disagree." }
        foreach ($Source in $Manifest.sources) {
            if (-not (Test-Path -LiteralPath (Join-Path $Normalized ([string]$Source.relativePath)) -PathType Leaf)) { throw "Manifest references a missing source file." }
        }
        Write-Host "Smoke passed: import, explore, and normalize."
    }

    if (-not $NoPackage) {
        $Python = Resolve-Python
        $env:CONTEXTDESK_BIN = $Binary
        $env:CLI_VERSION = $Version
        $env:CLI_PLATFORM = $Platform
        $env:CLI_GIT_SHA = $GitSha
        $env:CLI_GIT_DESCRIBE = $GitDescribe
        $env:CLI_CHANNEL = $Channel
        $env:CLI_TRIPLE = $Triple
        $env:CLI_OUT_DIR = $OutDir
        $PackageScript = Join-Path $Root "scripts/cli-release/package_cli_release.py"
        Invoke-Checked $Python.Command (@($Python.Prefix) + @($PackageScript, "package"))
        Write-Host "Release archive written under $OutDir"
    } else { Write-Host "Binary ready at $Binary" }
} finally {
    Pop-Location
    if (Test-Path -LiteralPath $TempRoot) { Remove-Item -LiteralPath $TempRoot -Recurse -Force }
}
