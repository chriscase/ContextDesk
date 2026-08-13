<##
.SYNOPSIS
    Preflight and serially demonstrate several log corpora through ContextDesk.

.DESCRIPTION
    This is an acceptance/demo harness, not a second agent implementation. Every
    operation is delegated to the supplied ContextDesk binary, so normalization,
    import, retrieval, provider setup, validation, tracing, and presentation are
    the same production paths used by the CLI.

    Without -Execute the script is provider-free: source inputs are normalized
    into fresh disposable output directories and existing corpus ids are checked
    with `corpus list`. With -Execute, sources additionally require -AllowImport
    and are imported, then each selected corpus receives exactly one serial chat
    turn. There are no retries, concurrency, matrices, or automatic model
    changes.

    Raw JSONL/stdout and stderr are retained locally under the output directory.
    The generated report.json/report.md contain only bounded aggregate fields;
    inspect them before sharing. No credentials, headers, endpoint URLs, prompts,
    or provider bodies are copied into the aggregate report.

.EXAMPLE
    .\demo-corpus-batch.ps1 -Cli .\contextdesk.exe `
      -DataDir "$env:LOCALAPPDATA\ContextDesk\demo-batch" `
      -Source .\case-a.zip, .\case-b `
      -OutputRoot (Join-Path $env:TEMP 'contextdesk-demo-output') -Execute -AllowImport `
      -Model 'qwen-3.6-27b' -Deadline 10m

.EXAMPLE
    .\demo-corpus-batch.ps1 -Cli .\contextdesk.exe `
      -DataDir "$env:LOCALAPPDATA\ContextDesk\acceptance-rc2" `
      -CorpusId '019fe3a6-58db-7800-874e-a4ccafffd07b' `
      -OutputRoot (Join-Path $env:TEMP 'contextdesk-demo-output') -Execute -Model 'deepseek-v4-flash'
##>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Cli,

    [Parameter(Mandatory = $true)]
    [string] $DataDir,

    [string] $AppConfig,

    [string[]] $Source = @(),

    [string[]] $CorpusId = @(),

    [string] $Model = 'qwen-3.6-27b',

    [string] $Deadline = '10m',

    [string] $Question = 'Review this corpus broadly. List the main independently supported incidents, observations, likely initiating causes, downstream symptoms, competing explanations, and missing evidence. Keep unrelated failures separate and do not claim a root cause unless the host evidence supports it.',

    [string] $OutputRoot = '',

    [switch] $Execute,

    [switch] $AllowImport
)

$ErrorActionPreference = 'Stop'

function Add-GlobalArgs {
    param([System.Collections.Generic.List[string]] $Arguments)
    $Arguments.Add('--data-dir')
    $Arguments.Add($DataDir)
    if (-not [string]::IsNullOrWhiteSpace($AppConfig)) {
        $Arguments.Add('--app-config')
        $Arguments.Add($AppConfig)
    }
}

function Get-CanonicalPath {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [switch] $MustExist
    )
    if ($MustExist) {
        return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    }
    return [System.IO.Path]::GetFullPath($Path)
}

function Test-PathWithin {
    param(
        [Parameter(Mandatory = $true)] [string] $Child,
        [Parameter(Mandatory = $true)] [string] $Parent
    )
    $parentRoot = ($Parent -replace '[\\/]+$', '') + [System.IO.Path]::DirectorySeparatorChar
    return $Child.StartsWith($parentRoot, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-PathSameOrWithin {
    param(
        [Parameter(Mandatory = $true)] [string] $Child,
        [Parameter(Mandatory = $true)] [string] $Parent
    )
    return $Child.Equals($Parent, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Test-PathWithin $Child $Parent)
}

function Test-ReparsePointInExistingPath {
    param([Parameter(Mandatory = $true)] [string] $Path)
    $candidate = [System.IO.Path]::GetFullPath($Path)
    while (-not [string]::IsNullOrWhiteSpace($candidate)) {
        if (Test-Path -LiteralPath $candidate) {
            $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                return $true
            }
        }
        $parent = [System.IO.Path]::GetDirectoryName($candidate)
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -ceq $candidate) { break }
        $candidate = $parent
    }
    return $false
}

function Invoke-CliCapture {
    param(
        [string[]] $Arguments,
        [string] $StdoutPath,
        [string] $StderrPath
    )

    $full = New-Object 'System.Collections.Generic.List[string]'
    foreach ($arg in $Arguments) { $full.Add($arg) }
    & $Cli @full 1> $StdoutPath 2> $StderrPath
    return [int]$LASTEXITCODE
}

function Read-JsonEnvelope {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $raw = [System.IO.File]::ReadAllText($Path)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

function Read-JsonLines {
    param([string] $Path)
    $values = @()
    $malformed = 0
    $nonempty = 0
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $nonempty++
            try { $values += ($line | ConvertFrom-Json) } catch { $malformed++ }
        }
    }
    return [pscustomobject]@{
        Values = @($values)
        Malformed = $malformed
        NonEmpty = $nonempty
    }
}

function Safe-Code {
    param([object] $Value)
    if ($null -eq $Value) { return $null }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return [regex]::Replace($text, '[^A-Za-z0-9_.-]', '_').Substring(0, [Math]::Min(96, $text.Length))
}

function Number-From {
    param([object] $Object, [string[]] $Names)
    if ($null -eq $Object) { return $null }
    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[$name]
        if ($null -ne $property -and $null -ne $property.Value) {
            try { return [int64]$property.Value } catch { }
        }
    }
    return $null
}

function Get-StrictBool {
    param([object] $Object, [string] $Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $property.Value -isnot [bool]) { return $null }
    return [bool]$property.Value
}

function New-CaseResult {
    param([int] $Index)
    return [ordered]@{
        case = ('case-{0:D2}' -f $Index)
        preflight = [ordered]@{ status = 'not-run' }
        import = [ordered]@{ status = 'not-run' }
        triage = [ordered]@{ status = 'not-run' }
        artifacts = [ordered]@{}
    }
}

if (-not (Test-Path -LiteralPath $Cli -PathType Leaf)) {
    throw "ContextDesk binary was not found at the supplied path."
}
if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
    throw "Data directory was not found; refusing to create or guess application state."
}
if ($Source.Count -eq 0 -and $CorpusId.Count -eq 0) {
    throw 'Provide at least one -Source or -CorpusId.'
}
if ($Source.Count -gt 0 -and $Execute -and -not $AllowImport) {
    throw 'Source execution changes durable state; add -AllowImport explicitly, or omit -Execute for provider-free preflight.'
}
if ($Execute -and [string]::IsNullOrWhiteSpace($Model)) {
    throw 'An exact discovered model id is required for -Execute.'
}

# Canonicalize and deduplicate source paths before any work begins. This avoids
# importing the same file twice through aliases such as `.` and an absolute path.
$sourceSeen = @{}
$canonicalSources = @()
foreach ($sourcePath in $Source) {
    $sourceItem = Get-Item -LiteralPath $sourcePath -ErrorAction Stop
    $sourceFull = Get-CanonicalPath $sourceItem.FullName -MustExist
    $sourceKey = $sourceFull.ToUpperInvariant()
    if (-not $sourceSeen.ContainsKey($sourceKey)) {
        $sourceSeen[$sourceKey] = $true
        $canonicalSources += $sourceFull
    }
}
$Source = @($canonicalSources)

# Corpus ids are opaque identities, but duplicate ids must not trigger duplicate
# provider turns. Preserve first occurrence and compare them byte-for-byte later.
$corpusSeen = @{}
$uniqueCorpusIds = @()
foreach ($corpus in $CorpusId) {
    $trimmed = ([string]$corpus).Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) { throw 'CorpusId cannot be blank.' }
    if (-not $corpusSeen.ContainsKey($trimmed)) {
        $corpusSeen[$trimmed] = $true
        $uniqueCorpusIds += $trimmed
    }
}
$CorpusId = @($uniqueCorpusIds)

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutputRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("contextdesk-demo-batch-{0}" -f $stamp)
}
if (Test-Path -LiteralPath $OutputRoot) {
    throw "Output directory already exists; refusing to overwrite it: $OutputRoot"
}
$outputFull = Get-CanonicalPath $OutputRoot
$dataFull = Get-CanonicalPath $DataDir -MustExist
$scriptRepoRoot = Get-CanonicalPath (Split-Path -Parent $PSScriptRoot) -MustExist
if (Test-ReparsePointInExistingPath $outputFull) {
    throw 'OutputRoot and its existing parents must not contain a symlink, junction, or other reparse point.'
}
if ((Test-PathSameOrWithin $outputFull $dataFull) -or (Test-PathSameOrWithin $dataFull $outputFull)) {
    throw 'OutputRoot and DataDir must be separate trees.'
}
if (Test-PathSameOrWithin $outputFull $scriptRepoRoot) {
    throw 'OutputRoot must be outside the ContextDesk checkout to prevent corpus-derived artifacts entering the repository.'
}
foreach ($sourceFull in $Source) {
    $sourceItem = Get-Item -LiteralPath $sourceFull -ErrorAction Stop
    if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Source inputs must not be symlinks, junctions, or other reparse points.'
    }
    $sourceRoot = if ($sourceItem.PSIsContainer) {
        $sourceFull
    } else {
        [System.IO.Path]::GetDirectoryName($sourceFull)
    }
    if ((Test-PathSameOrWithin $outputFull $sourceRoot) -or (Test-PathSameOrWithin $sourceRoot $outputFull)) {
        throw 'OutputRoot must be outside every source tree in both directions.'
    }
}
$OutputRoot = $outputFull
$null = New-Item -ItemType Directory -Path $OutputRoot
$RawRoot = Join-Path $OutputRoot 'raw-local-only'
$NormalizedRoot = Join-Path $OutputRoot 'normalized-preflight'
$null = New-Item -ItemType Directory -Path $RawRoot
$null = New-Item -ItemType Directory -Path $NormalizedRoot

$results = @()
$pendingCorpusCases = @()
$importedCorpusIds = @()
$index = 0

foreach ($sourcePath in $Source) {
    $index++
    $case = New-CaseResult $index
    $sourceItem = Get-Item -LiteralPath $sourcePath -ErrorAction Stop
    $caseDir = Join-Path $RawRoot ('case-{0:D2}' -f $index)
    $null = New-Item -ItemType Directory -Path $caseDir
    $case.artifacts.preflight_stdout = ('case-{0:D2}-normalize.stdout.json' -f $index)
    $case.artifacts.preflight_stderr = ('case-{0:D2}-normalize.stderr.txt' -f $index)

    $normalizedPath = Join-Path $NormalizedRoot ('case-{0:D2}' -f $index)
    $args = New-Object 'System.Collections.Generic.List[string]'
    Add-GlobalArgs $args
    $args.Add('--json')
    $args.Add('normalize')
    $args.Add($sourceItem.FullName)
    $args.Add('--output')
    $args.Add($normalizedPath)
    $args.Add('--output-format')
    $args.Add('jsonl')
    $args.Add('--fail-on-partial')
    Write-Host ('[{0:D2}/{1:D2}] OFFLINE PREFLIGHT  {2}' -f $index, $Source.Count, ('source-{0:D2}' -f $index))
    $exit = Invoke-CliCapture $args `
        (Join-Path $caseDir ('case-{0:D2}-normalize.stdout.json' -f $index)) `
        (Join-Path $caseDir ('case-{0:D2}-normalize.stderr.txt' -f $index))
    $envelope = Read-JsonEnvelope (Join-Path $caseDir ('case-{0:D2}-normalize.stdout.json' -f $index))
    $data = if ($null -ne $envelope) { $envelope.data } else { $null }
    $preflightPartial = Get-StrictBool $data 'partial'
    $preflightEnvelopeOk = Get-StrictBool $envelope 'ok'
    $preflightEvents = Number-From $data @('events_imported', 'events', 'record_count')
    $preflightSelected = Number-From $data @('sources_selected', 'selected_sources')
    $preflightFailed = Number-From $data @('sources_failed', 'failed_sources')
    $preflightOk = $preflightEnvelopeOk -eq $true -and $exit -eq 0 -and
        $preflightPartial -eq $false -and ($preflightEvents -as [int64]) -gt 0 -and
        ($preflightSelected -as [int64]) -gt 0 -and ($preflightFailed -as [int64]) -eq 0
    $case.preflight = [ordered]@{
        status = if ($preflightOk) { 'pass' } else { 'fail' }
        exit_code = $exit
        ok = $preflightEnvelopeOk
        partial = $preflightPartial
        events = $preflightEvents
        sources = $preflightSelected
        failed_sources = $preflightFailed
        error_code = if ($null -ne $envelope.error) { Safe-Code $envelope.error.kind } else { $null }
    }

    if ($Execute -and $case.preflight.status -eq 'pass') {
        $importStdout = Join-Path $caseDir ('case-{0:D2}-import.stdout.json' -f $index)
        $importStderr = Join-Path $caseDir ('case-{0:D2}-import.stderr.txt' -f $index)
        $case.artifacts.import_stdout = [System.IO.Path]::GetFileName($importStdout)
        $case.artifacts.import_stderr = [System.IO.Path]::GetFileName($importStderr)
        $args = New-Object 'System.Collections.Generic.List[string]'
        Add-GlobalArgs $args
        $args.Add('--json')
        $args.Add('import')
        $args.Add($sourceItem.FullName)
        $args.Add('--name')
        $args.Add(('demo-case-{0:D2}' -f $index))
        Write-Host ('[{0:D2}/{1:D2}] IMPORT              {2}' -f $index, $Source.Count, ('case-{0:D2}' -f $index))
        $importExit = Invoke-CliCapture $args $importStdout $importStderr
        $importEnvelope = Read-JsonEnvelope $importStdout
        $importData = if ($null -ne $importEnvelope) { $importEnvelope.data } else { $null }
        $importId = if ($null -ne $importData) { [string]$importData.corpus_id } else { '' }
        $importPartial = Get-StrictBool $importData 'partial'
        $importEnvelopeOk = Get-StrictBool $importEnvelope 'ok'
        $importEvents = Number-From $importData @('events_imported', 'events')
        $importSelected = Number-From $importData @('sources_selected', 'selected_sources')
        $importFailed = Number-From $importData @('sources_failed', 'failed_sources')
        $importAmbiguous = 0
        if ($null -ne $importData -and
            $null -ne $importData.PSObject.Properties['timezone_ambiguous_sources']) {
            $importAmbiguous = @($importData.timezone_ambiguous_sources | Where-Object {
                -not [string]::IsNullOrWhiteSpace([string]$_)
            }).Count
        }
        $importOperationalOk = $importEnvelopeOk -eq $true -and
            $importExit -eq 0 -and $importPartial -eq $false -and
            -not [string]::IsNullOrWhiteSpace($importId) -and
            ($importEvents -as [int64]) -gt 0 -and
            ($importSelected -as [int64]) -gt 0 -and ($importFailed -as [int64]) -eq 0
        $case.import = [ordered]@{
            status = if (-not $importOperationalOk) { 'fail' } elseif ($importAmbiguous -gt 0) { 'needs-timezone' } else { 'pass' }
            exit_code = $importExit
            ok = $importEnvelopeOk
            partial = $importPartial
            events = $importEvents
            templates = Number-From $importData @('templates_imported', 'templates')
            sources = $importSelected
            failed_sources = $importFailed
            timezone_unresolved_sources = $importAmbiguous
            has_corpus = -not [string]::IsNullOrWhiteSpace($importId)
            error_code = if ($null -ne $importEnvelope.error) { Safe-Code $importEnvelope.error.kind } else { $null }
        }
        if ($case.import.status -eq 'pass') {
            $CorpusId += $importId
            $importedCorpusIds += $importId
            $pendingCorpusCases += [pscustomobject]@{ Case = $case; CorpusId = $importId }
        }
    }
    $results += $case
}

if ($CorpusId.Count -gt 0) {
    $listCase = Join-Path $RawRoot 'corpus-list'
    $null = New-Item -ItemType Directory -Path $listCase
    $listStdout = Join-Path $listCase 'corpus-list.stdout.json'
    $listStderr = Join-Path $listCase 'corpus-list.stderr.txt'
    $args = New-Object 'System.Collections.Generic.List[string]'
    Add-GlobalArgs $args
    $args.Add('--json')
    $args.Add('corpus')
    $args.Add('list')
    $listExit = Invoke-CliCapture $args $listStdout $listStderr
    $listEnvelope = Read-JsonEnvelope $listStdout
    $listOk = Get-StrictBool $listEnvelope 'ok'
    if ($listExit -ne 0 -or $listOk -ne $true) {
        throw 'Corpus list did not produce a successful JSON envelope.'
    }
    $known = @()
    if ($null -ne $listEnvelope -and $null -ne $listEnvelope.data.corpora) {
        $known = @($listEnvelope.data.corpora | ForEach-Object { [string]$_.id })
    }
    $missing = @($CorpusId | Where-Object { $known -notcontains $_ })
    if ($missing.Count -gt 0) {
        throw 'One or more requested corpus ids were not present in the existing data directory.'
    }

    foreach ($cid in $CorpusId) {
        if ($importedCorpusIds -contains $cid) { continue }
        $existingCase = New-CaseResult ($results.Count + 1)
        $tzCase = Join-Path $RawRoot ('corpus-{0}' -f $existingCase.case)
        $null = New-Item -ItemType Directory -Path $tzCase
        $tzStdout = Join-Path $tzCase 'timezone.stdout.json'
        $tzStderr = Join-Path $tzCase 'timezone.stderr.txt'
        $tzArgs = New-Object 'System.Collections.Generic.List[string]'
        Add-GlobalArgs $tzArgs
        $tzArgs.Add('--json')
        $tzArgs.Add('timezone')
        $tzArgs.Add('status')
        $tzArgs.Add('--corpus')
        $tzArgs.Add($cid)
        $tzExit = Invoke-CliCapture $tzArgs $tzStdout $tzStderr
        $tzEnvelope = Read-JsonEnvelope $tzStdout
        $tzSources = if ($null -ne $tzEnvelope -and $null -ne $tzEnvelope.data.sources) {
            @($tzEnvelope.data.sources)
        } else { @() }
        $tzShapeOk = $tzSources.Count -gt 0
        $tzUnresolved = 0
        foreach ($tzSource in $tzSources) {
            $unresolved = Number-From $tzSource @('unresolved_local_records')
            if ($null -eq $unresolved -or $unresolved -lt 0) {
                $tzShapeOk = $false
            } else {
                $tzUnresolved += $unresolved
            }
        }
        $tzEnvelopeOk = Get-StrictBool $tzEnvelope 'ok'
        $tzOk = $tzEnvelopeOk -eq $true -and $tzExit -eq 0 -and
            $tzShapeOk -and $tzUnresolved -eq 0
        $existingCase.preflight = [ordered]@{
            status = if ($tzOk) { 'existing' } else { 'needs-timezone' }
            source_scan = 'not-run'
            timezone_status = if ($tzOk) { 'resolved' } else { 'unresolved-or-unavailable' }
            timezone_unresolved_sources = $tzUnresolved
            timezone_exit_code = $tzExit
            timezone_error_code = if ($null -ne $tzEnvelope.error) { Safe-Code $tzEnvelope.error.kind } else { $null }
        }
        $results += $existingCase
        if ($tzOk) {
            $pendingCorpusCases += [pscustomobject]@{ Case = $existingCase; CorpusId = $cid }
        }
    }
}

if ($Execute) {
    $triageIndex = 0
    foreach ($item in $pendingCorpusCases) {
        $triageIndex++
        $case = $item.Case
        $cid = [string]$item.CorpusId
        $caseNumber = [int]($case.case -replace '^case-', '')
        $caseDir = Join-Path $RawRoot ('case-{0:D2}' -f $caseNumber)
        if (-not (Test-Path -LiteralPath $caseDir)) { $null = New-Item -ItemType Directory -Path $caseDir }
        $stdout = Join-Path $caseDir ('case-{0:D2}-chat.jsonl' -f $caseNumber)
        $stderr = Join-Path $caseDir ('case-{0:D2}-chat.stderr.txt' -f $caseNumber)
        $args = New-Object 'System.Collections.Generic.List[string]'
        Add-GlobalArgs $args
        $args.Add('--jsonl')
        $args.Add('--no-color')
        $args.Add('--model')
        $args.Add($Model)
        $args.Add('--deadline')
        $args.Add($Deadline)
        $args.Add('chat')
        $args.Add($Question)
        $args.Add('--corpus')
        $args.Add($cid)
        $args.Add('--new')
        $args.Add('--mode')
        $args.Add('single')
        $args.Add('--trace')
        $args.Add('summary')
        $args.Add('--activity')
        $args.Add('summary')
        Write-Host ('[{0:D2}/{1:D2}] ONE TRIAGE TURN      {2}' -f $triageIndex, $CorpusId.Count, ('corpus-{0:D2}' -f $triageIndex))
        $chatExit = Invoke-CliCapture $args $stdout $stderr
        $parsed = Read-JsonLines $stdout
        $lines = @($parsed.Values)
        $done = @($lines | Where-Object { $_.operation -eq 'done' })
        $trace = @($lines | Where-Object { $_.operation -eq 'trace_summary' })
        $errorLines = @($lines | Where-Object { $_.operation -eq 'error' })
        $typed = @($lines | Where-Object { $_.operation -eq 'investigation_answer' }).Count -gt 0
        $doneOk = $false
        if ($done.Count -eq 1) {
            $doneOk = (Get-StrictBool $done[0] 'ok') -eq $true
        }
        $answerText = if ($done.Count -eq 1) { [string]$done[0].final_text } else { '' }
        $lastOperation = if ($lines.Count -gt 0) { [string]$lines[-1].operation } else { $null }
        $modelMatches = $trace.Count -eq 1 -and ([string]$trace[0].chat_model -ceq $Model)
        $corpusMatches = $trace.Count -eq 1 -and ([string]$trace[0].corpus_id -ceq $cid)
        $liveTrace = $false
        if ($trace.Count -eq 1) {
            $dryRun = Get-StrictBool $trace[0] 'dry_run'
            $liveTrace = $dryRun -eq $false
        }
        $grounding = if ($trace.Count -eq 1) { Safe-Code $trace[0].grounding } else { $null }
        $quality = if ($typed) { 'host_validated' } elseif ($grounding -eq 'grounded') { 'provisional' } else { 'not_grounded' }
        $triageOperationalOk = $chatExit -eq 0 -and $parsed.Malformed -eq 0 -and
            $parsed.NonEmpty -gt 0 -and $done.Count -eq 1 -and
            $lastOperation -eq 'done' -and $doneOk -and
            -not [string]::IsNullOrWhiteSpace($answerText) -and
            $errorLines.Count -eq 0 -and $trace.Count -eq 1 -and
            $modelMatches -and $corpusMatches -and $liveTrace -and
            $grounding -eq 'grounded'
        $case.triage = [ordered]@{
            status = if ($triageOperationalOk) { 'pass' } else { 'fail' }
            exit_code = $chatExit
            terminal_ok = $doneOk
            terminal_line_last = $lastOperation -eq 'done'
            malformed_lines = $parsed.Malformed
            nonempty_lines = $parsed.NonEmpty
            error_events = $errorLines.Count
            typed_answer = $typed
            validation_tier = $quality
            grounding = $grounding
            model_matches = $modelMatches
            corpus_matches = $corpusMatches
            live_trace = $liveTrace
            answer_chars = $answerText.Length
            elapsed_ms = if ($trace.Count -eq 1) { Number-From $trace[0] @('turn_elapsed_ms', 'elapsed_ms') } else { $null }
            provider_calls_ms = if ($trace.Count -eq 1) { Number-From $trace[0] @('provider_call_elapsed_ms_sum') } else { $null }
            error_code = if ($errorLines.Count -gt 0) { Safe-Code $errorLines[0].code } else { $null }
        }
        $case.artifacts.chat_stdout = [System.IO.Path]::GetFileName($stdout)
        $case.artifacts.chat_stderr = [System.IO.Path]::GetFileName($stderr)
        $answerPath = Join-Path $caseDir ('case-{0:D2}-answer.md' -f $caseNumber)
        $answerDocument = @(
            ('# ContextDesk answer - {0}' -f $case.case)
            ''
            ('Model: `{0}`' -f $Model)
            ('Grounding: `{0}`' -f $(if ($null -ne $grounding) { $grounding } else { 'unknown' }))
            ('Validation tier: `{0}`' -f $quality)
            ('Typed host answer emitted: `{0}`' -f $typed)
            ''
            '---'
            ''
            $answerText
        )
        $answerDocument | Set-Content -LiteralPath $answerPath -Encoding UTF8
        $case.artifacts.answer_markdown = [System.IO.Path]::GetFileName($answerPath)
    }
}

$report = [ordered]@{
    schema = 'contextdesk.demo_corpus_batch.v1'
    local_only = $true
    executed = [bool]$Execute
    model = if ($Execute) { $Model } else { $null }
    deadline = if ($Execute) { $Deadline } else { $null }
    case_count = $results.Count
    pass_count = @($results | Where-Object { $_.triage.status -eq 'pass' }).Count
    fail_count = @($results | Where-Object { $_.triage.status -eq 'fail' }).Count
    preflight_fail_count = @($results | Where-Object { $_.preflight.status -eq 'fail' }).Count
    needs_timezone_count = @($results | Where-Object {
        $_.preflight.status -eq 'needs-timezone' -or $_.import.status -eq 'needs-timezone'
    }).Count
    results = $results
}
$requiredFailures = if ($Execute) {
    @($results | Where-Object { $_.triage.status -ne 'pass' }).Count
} else {
    @($results | Where-Object {
        $_.preflight.status -notin @('pass', 'existing')
    }).Count
}
$report.all_required_passed = $results.Count -gt 0 -and $requiredFailures -eq 0
$reportPath = Join-Path $OutputRoot 'report.json'
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding UTF8

$md = New-Object System.Collections.Generic.List[string]
$md.Add('# ContextDesk corpus batch')
$md.Add('')
$md.Add('This is an aggregate report. Raw JSONL/stdout and stderr remain local under `raw-local-only/` and are not share-safe.')
$md.Add('')
$md.Add(('| Executed | Cases | Triage pass | Triage fail |' ))
$md.Add('| --- | ---: | ---: | ---: |')
$md.Add(('| {0} | {1} | {2} | {3} |' -f ([bool]$Execute), $report.case_count, $report.pass_count, $report.fail_count))
$md.Add('')
$md.Add('| Case | Preflight | Import | Triage | Validation | Typed answer | Grounding | Elapsed ms |')
$md.Add('| --- | --- | --- | --- | --- | --- | --- | ---: |')
foreach ($row in $results) {
    $md.Add(('| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} |' -f $row.case, $row.preflight.status, $row.import.status, $row.triage.status, $row.triage.validation_tier, $row.triage.typed_answer, $row.triage.grounding, $row.triage.elapsed_ms))
}
$md.Add('')
$md.Add('Per-case answer Markdown files are local-only artifacts beside each captured JSONL turn. They are intended for operator review and may contain corpus-derived text.')
$md.Add('')
$md.Add('Interpretation, causal claims, and evidence completeness require human review of each local answer. `grounding=grounded` only certifies host citation identity, not model correctness.')
$mdPath = Join-Path $OutputRoot 'report.md'
$md | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-Host ''
Write-Host '=== BATCH SUMMARY ==='
Write-Host ('Cases recorded: {0}' -f $report.case_count)
Write-Host ('Triage passed:  {0}' -f $report.pass_count)
Write-Host ('Triage failed:  {0}' -f $report.fail_count)
Write-Host ('Required gates: {0}' -f $(if ($report.all_required_passed) { 'PASS' } else { 'FAIL' }))
Write-Host 'Aggregate files: report.json, report.md'
Write-Host 'Raw files:       local-only under raw-local-only/ (do not upload)'
if (-not $Execute) { Write-Host 'Provider calls:  0 (preflight only)' }
if (-not $report.all_required_passed) { exit 1 }
