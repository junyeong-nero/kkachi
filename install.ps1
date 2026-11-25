# Kkachi in one command on Windows: installs what is missing (Git, Bun, Pi, Tailscale), puts Kkachi
# in ~\kkachi (or $env:KKACHI_DIR) and runs its setup (bun run init), which asks the rest.
#   powershell -c "irm https://raw.githubusercontent.com/junyeong-nero/kkachi/main/install.ps1 | iex"
# Safe to run again: it installs nothing that is there, and updates Kkachi instead of cloning it.
$ErrorActionPreference = "Stop"

$dir = if ($env:KKACHI_DIR) { $env:KKACHI_DIR } else { Join-Path $HOME "kkachi" }
function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Say($text) { Write-Host "`n$text" }
# Installers add themselves to the user's PATH; read it again so this window sees them.
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") }
function Winget($id, $what) {
  if (-not (Have winget)) { Say "Install $what yourself (winget is missing), then run this again."; exit 1 }
  winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements
  Update-Path
}

if (-not (Have git)) { Say "Installing Git"; Winget "Git.Git" "Git (https://git-scm.com/downloads)" }
if (-not (Have bun)) { Say "Installing Bun (https://bun.sh)"; powershell -c "irm bun.sh/install.ps1 | iex"; Update-Path }
if (-not (Have pi)) { Say "Installing Pi, the agent Kkachi runs on (https://pi.dev)"; powershell -c "irm https://pi.dev/install.ps1 | iex"; Update-Path }
if (-not (Have tailscale)) {
  Say "Installing Tailscale, so your phone can reach this computer and nothing else can"
  Winget "Tailscale.Tailscale" "Tailscale (https://tailscale.com/download)"
}

if (Test-Path (Join-Path $dir ".git")) {
  Say "Updating Kkachi in $dir"
  git -C $dir pull --ff-only
} else {
  Say "Getting Kkachi into $dir"
  git clone https://github.com/junyeong-nero/kkachi.git $dir
}

Set-Location $dir
bun run init
