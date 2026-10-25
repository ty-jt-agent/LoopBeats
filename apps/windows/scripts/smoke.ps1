$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$executable = Join-Path $PSScriptRoot '..\src-tauri\target\x86_64-pc-windows-msvc\release\loopbeats-windows.exe'
$executable = (Resolve-Path $executable).Path
$process = Start-Process -FilePath $executable -PassThru

try {
  $deadline = (Get-Date).AddSeconds(30)
  $verified = $false

  while ((Get-Date) -lt $deadline -and -not $verified) {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited) {
      throw "LoopBeats exited during startup with code $($process.ExitCode)."
    }
    if ($process.MainWindowHandle -eq 0) {
      continue
    }

    try {
      $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
      $elements = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      $accessibleText = @($window.Current.Name)
      foreach ($element in $elements) {
        if ($element.Current.Name) {
          $accessibleText += $element.Current.Name
        }
      }
      $accessibleText = $accessibleText -join "`n"
      $verified = $accessibleText.Contains('Audio could not start') -and
        $accessibleText.Contains('Windows audio host error') -and
        $accessibleText.Contains('native Windows audio host is not included')
    } catch {
      # The UI Automation tree may not be ready until WebView2 finishes loading.
    }
  }

  if (-not $verified) {
    throw 'The bundled UI did not show the expected unavailable Windows audio host state.'
  }

  Write-Host 'Windows shell launch smoke passed: bundled UI rendered the expected unavailable-host error.'
} finally {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
}
