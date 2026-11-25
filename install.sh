#!/bin/sh
# Kkachi in one command on macOS or Linux: installs what is missing (Git, Bun, Pi, Tailscale), puts
# Kkachi in ~/kkachi (or $KKACHI_DIR) and runs its setup (bun run init), which asks the rest.
#   curl -fsSL https://raw.githubusercontent.com/junyeong-nero/kkachi/main/install.sh | sh
# Safe to run again: it installs nothing that is there, and updates Kkachi instead of cloning it.
set -e

DIR="${KKACHI_DIR:-$HOME/kkachi}"
have() { command -v "$1" >/dev/null 2>&1; }
say() { printf '\n%s\n' "$*"; }
os=$(uname -s)

if ! have git; then
  say "Installing Git"
  if [ "$os" = Darwin ]; then
    xcode-select --install 2>/dev/null || true
    say "Finish installing Apple's command line tools in the window that opened, then run this again."
    exit 1
  elif have apt-get; then sudo apt-get update && sudo apt-get install -y git
  elif have dnf; then sudo dnf install -y git
  elif have pacman; then sudo pacman -S --noconfirm git
  else say "Install git with your package manager, then run this again."; exit 1
  fi
fi

if ! have bun; then
  say "Installing Bun (https://bun.sh)"
  curl -fsSL https://bun.sh/install | bash
  PATH="$HOME/.bun/bin:$PATH"
fi

if ! have pi; then
  say "Installing Pi, the agent Kkachi runs on (https://pi.dev)"
  curl -fsSL https://pi.dev/install.sh | sh
  PATH="$HOME/.pi/agent/bin:$HOME/.local/bin:$PATH"
fi

if ! have tailscale; then
  say "Installing Tailscale, so your phone can reach this computer and nothing else can"
  if [ "$os" = Darwin ]; then
    if have brew; then brew install --cask tailscale
    else say "Install Tailscale from https://tailscale.com/download (skip it to use Kkachi on this computer only)."
    fi
  else curl -fsSL https://tailscale.com/install.sh | sh
  fi
fi
export PATH

if [ -d "$DIR/.git" ]; then
  say "Updating Kkachi in $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Getting Kkachi into $DIR"
  git clone https://github.com/junyeong-nero/kkachi.git "$DIR"
fi

cd "$DIR"
# Piped from curl, this script's stdin is the script itself: the setup's questions need the terminal.
bun run init < /dev/tty
