export function connectHelperScript(platform: "linux" | "macos" | "windows", configUrl: string): string {
  if (platform === "windows") {
    return [
      "$ErrorActionPreference = 'Stop'",
      "$configPath = Join-Path $env:USERPROFILE 'Downloads\\hyperspace.conf'",
      `Invoke-WebRequest -UseBasicParsing -Uri '${configUrl}' -OutFile $configPath`,
      "if (Select-String -Path $configPath -Pattern '^\\s*(Jc|HeaderProtectionKey)\\s*=' -Quiet) {",
      "  Write-Host 'Import Downloads\\hyperspace.conf into AmneziaWG 3.1 or newer. Ordinary WireGuard cannot connect with this configuration.'",
      "  Start-Process explorer.exe -ArgumentList ('/select,\"' + $configPath + '\"')",
      "  exit 0",
      "}",
      "$wireGuard = Join-Path $env:ProgramFiles 'WireGuard\\wireguard.exe'",
      "if (-not (Test-Path $wireGuard)) { winget install --id WireGuard.WireGuard -e --accept-package-agreements --accept-source-agreements }",
      "Start-Process -FilePath $wireGuard -ArgumentList @('/installtunnelservice', $configPath) -Verb RunAs -Wait",
      "Write-Host 'Hyperspace tunnel installed and started.'"
    ].join("\r\n");
  }
  if (platform === "macos") {
    return [
      "#!/usr/bin/env bash", "set -euo pipefail", "umask 077",
      'config_path="$HOME/Downloads/hyperspace.conf"',
      `curl -fsSL '${configUrl}' -o "$config_path"`,
      'chmod 600 "$config_path"',
      'if grep -Eq "^[[:space:]]*(Jc|HeaderProtectionKey)[[:space:]]*=" "$config_path"; then',
      "  echo 'Import hyperspace.conf into AmneziaWG 3.1 or newer.'",
      '  open -R "$config_path"',
      'elif [ -d /Applications/WireGuard.app ]; then open -a WireGuard "$config_path";',
      "else echo 'Install WireGuard from the App Store, then open hyperspace.conf.'; open -R \"$config_path\"; fi"
    ].join("\n");
  }
  return [
    "#!/usr/bin/env bash", "set -euo pipefail", "umask 077",
    "tmp_config=$(mktemp)", 'trap \'rm -f "$tmp_config"\' EXIT',
    `curl -fsSL '${configUrl}' -o "$tmp_config"`,
    'if grep -Eq "^[[:space:]]*(Jc|HeaderProtectionKey)[[:space:]]*=" "$tmp_config"; then',
    "  quick=awg-quick; config_dir=/etc/amnezia/amneziawg",
    '  if ! command -v "$quick" >/dev/null; then',
    "    echo 'Install AmneziaWG 3.1 tools and kernel module: https://docs.amnezia.org/documentation/amnezia-wg/' >&2; exit 1",
    "  fi",
    "else",
    "  quick=wg-quick; config_dir=/etc/wireguard",
    '  if ! command -v "$quick" >/dev/null; then',
    "    if command -v apt-get >/dev/null; then sudo apt-get update && sudo apt-get install -y wireguard-tools;",
    "    elif command -v dnf >/dev/null; then sudo dnf install -y wireguard-tools;",
    "    else echo 'Install WireGuard tools first.' >&2; exit 1; fi",
    "  fi",
    "fi",
    'sudo install -d -m 700 "$config_dir"',
    'sudo install -m 600 "$tmp_config" "$config_dir/hyperspace.conf"',
    'sudo "$quick" down "$config_dir/hyperspace.conf" >/dev/null 2>&1 || true',
    'sudo "$quick" up "$config_dir/hyperspace.conf"',
    "echo 'Hyperspace tunnel is connected.'"
  ].join("\n");
}
