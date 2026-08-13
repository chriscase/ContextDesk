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
      -OutputRoot .\demo-output -Execute -AllowImport `
      -Model 'qwen-3.6-27b' -Deadline 10m

.EXAMPLE
    .\demo-corpus-batch.ps1 -Cli .\contextdesk.exe `
      -DataDir "$env:LOCALAPPDATA\ContextDesk\acceptance-rc2" `
      -CorpusId '019fe3a6-58db-7800-874e-a4ccafffd07b' `
      -OutputRoot .\demo-output -Execute -Model 'deepseek-v4-flash'
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
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $values }
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $values += ($line | ConvertFrom-Json) } catch { }
    }
    return $values
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

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutputRoot = Join-Path (Get-Location) ("contextdesk-demo-batch-{0}" -f $stamp)
}
if (Test-Path -LiteralPath $OutputRoot) {
    throw "Output directory already exists; refusing to overwrite it: $OutputRoot"
}
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
    Write-Host ('[{0:D2}/{1:D2}] OFFLINE PREFLIGHT  {2}' -f $index, $Source.Count, ('source-{0:D2}' -f $index))
    $exit = Invoke-CliCapture $args `
        (Join-Path $caseDir ('case-{0:D2}-normalize.stdout.json' -f $index)) `
        (Join-Path $caseDir ('case-{0:D2}-normalize.stderr.txt' -f $index))
    $envelope = Read-JsonEnvelope (Join-Path $caseDir ('case-{0:D2}-normalize.stdout.json' -f $index))
    $data = if ($null -ne $envelope) { $envelope.data } else { $null }
    $case.preflight = [ordered]@{
        status = if ($null -ne $envelope -and [bool]$envelope.ok) { 'pass' } else { 'fail' }
        exit_code = $exit
        ok = if ($null -ne $envelope) { [bool]$envelope.ok } else { $false }
        events = Number-From $data @('events_imported', 'events', 'record_count')
        sources = Number-From $data @('sources_selected', 'selected_sources')
        failed_sources = Number-From $data @('sources_failed', 'failed_sources')
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
        $case.import = [ordered]@{
            status = if ($null -ne $importEnvelope -and [bool]$importEnvelope.ok -and -not [string]::IsNullOrWhiteSpace($importId)) { 'pass' } else { 'fail' }
            exit_code = $importExit
            ok = if ($null -ne $importEnvelope) { [bool]$importEnvelope.ok } else { $false }
            events = Number-From $importData @('events_imported', 'events')
            templates = Number-From $importData @('templates_imported', 'templates')
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
        $existingCase.preflight = [ordered]@{ status = 'existing'; source_scan = 'not-run' }
        $results += $existingCase
        $pendingCorpusCases += [pscustomobject]@{ Case = $existingCase; CorpusId = $cid }
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
        $args.Add('--auto-approve')
        $args.Add('--trace')
        $args.Add('summary')
        $args.Add('--activity')
        $args.Add('summary')
        Write-Host ('[{0:D2}/{1:D2}] ONE TRIAGE TURN      {2}' -f $triageIndex, $CorpusId.Count, ('corpus-{0:D2}' -f $triageIndex))
        $chatExit = Invoke-CliCapture $args $stdout $stderr
        $lines = @(Read-JsonLines $stdout)
        $done = @($lines | Where-Object { $_.operation -eq 'done' } | Select-Object -Last 1)
        $trace = @($lines | Where-Object { $_.operation -eq 'trace_summary' } | Select-Object -Last 1)
        $errorLine = @($lines | Where-Object { $_.operation -eq 'error' } | Select-Object -Last 1)
        $typed = @($lines | Where-Object { $_.operation -eq 'investigation_answer' }).Count -gt 0
        $doneOk = $done.Count -eq 1 -and [bool]$done[0].ok
        $grounding = if ($trace.Count -eq 1) { Safe-Code $trace[0].grounding } else { $null }
        $case.triage = [ordered]@{
            status = if ($doneOk -and $chatExit -eq 0) { 'pass' } else { 'fail' }
            exit_code = $chatExit
            terminal_ok = $doneOk
            typed_answer = $typed
            grounding = $grounding
            elapsed_ms = if ($trace.Count -eq 1) { Number-From $trace[0] @('turn_elapsed_ms', 'elapsed_ms') } else { $null }
            provider_calls_ms = if ($trace.Count -eq 1) { Number-From $trace[0] @('provider_call_elapsed_ms_sum') } else { $null }
            error_code = if ($errorLine.Count -eq 1) { Safe-Code $errorLine[0].code } else { $null }
        }
        $case.artifacts.chat_stdout = [System.IO.Path]::GetFileName($stdout)
        $case.artifacts.chat_stderr = [System.IO.Path]::GetFileName($stderr)
        $answerPath = Join-Path $caseDir ('case-{0:D2}-answer.md' -f $caseNumber)
        $answerText = if ($doneOk) { [string]$done[0].final_text } else { '' }
        $answerDocument = @(
            ('# ContextDesk answer - {0}' -f $case.case)
            ''
            ('Model: `{0}`' -f $Model)
            ('Grounding: `{0}`' -f $(if ($null -ne $grounding) { $grounding } else { 'unknown' }))
            ('Typed host answer emitted: `{0}`' -f $typed)
            ''
            '---'
            ''
            $answerText
        )
        $answerDocument | Set-Content -LiteralPath $answerPath -Encoding UTF8
        $case.triage.answer_chars = $answerText.Length
        $case.artifacts.answer_markdown = [System.IO.Path]::GetFileName($answerPath)
    }
}

$report = [ordered]@{
    schema = 'contextdesk.demo_corpus_batch.v1'
    executed = [bool]$Execute
    model = if ($Execute) { $Model } else { $null }
    deadline = if ($Execute) { $Deadline } else { $null }
    case_count = $results.Count
    pass_count = @($results | Where-Object { $_.triage.status -eq 'pass' }).Count
    fail_count = @($results | Where-Object { $_.triage.status -eq 'fail' }).Count
    results = $results
}
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
$md.Add('| Case | Preflight | Import | Triage | Typed answer | Grounding | Elapsed ms |')
$md.Add('| --- | --- | --- | --- | --- | --- | ---: |')
foreach ($row in $results) {
    $md.Add(('| {0} | {1} | {2} | {3} | {4} | {5} | {6} |' -f $row.case, $row.preflight.status, $row.import.status, $row.triage.status, $row.triage.typed_answer, $row.triage.grounding, $row.triage.elapsed_ms))
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
Write-Host 'Aggregate files: report.json, report.md'
Write-Host 'Raw files:       local-only under raw-local-only/ (do not upload)'
if (-not $Execute) { Write-Host 'Provider calls:  0 (preflight only)' }
