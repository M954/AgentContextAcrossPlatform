param(
    [Parameter(Mandatory = $true)][string]$Storyboard,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$Voice = 'Microsoft Zira Desktop'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$plan = Get-Content -LiteralPath $Storyboard -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $speech.SelectVoice($Voice)
    $speech.Rate = 0
    $speech.Volume = 100
    foreach ($scene in $plan.scenes) {
        if ($scene.id -notmatch '^[a-z0-9-]+$') { throw 'Invalid scene identifier' }
        $output = Join-Path $OutputDirectory ($scene.id + '.wav')
        $speech.SetOutputToWaveFile($output)
        $speech.Speak([string]$scene.narration)
        $speech.SetOutputToNull()
    }
} finally {
    $speech.Dispose()
}
