param(
    [Parameter(Mandatory = $true)][string]$Storyboard,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$Voice = 'Microsoft David Desktop',
    [ValidateRange(-10, 10)][int]$Rate = 1,
    [ValidateRange(-10, 20)][int]$PitchPercent = 5
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$plan = Get-Content -LiteralPath $Storyboard -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $speech.SelectVoice($Voice)
    $speech.Rate = $Rate
    $speech.Volume = 100
    foreach ($scene in $plan.scenes) {
        if ($scene.id -notmatch '^[a-z0-9-]+$') { throw 'Invalid scene identifier' }
        $output = Join-Path $OutputDirectory ($scene.id + '.wav')
        $speech.SetOutputToWaveFile($output)
        $escaped = [Security.SecurityElement]::Escape([string]$scene.narration)
        $pitch = if ($PitchPercent -ge 0) { "+$PitchPercent%" } else { "$PitchPercent%" }
        $speech.SpeakSsml("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><prosody pitch='$pitch'>$escaped</prosody></speak>")
        $speech.SetOutputToNull()
    }
    @{ voice = $Voice; rate = $Rate; pitchPercent = $PitchPercent; mode = 'Offline Windows speech synthesis' } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'narration-info.json') -Encoding UTF8
} finally {
    $speech.Dispose()
}
