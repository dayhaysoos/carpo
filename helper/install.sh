#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_PATH="${SCRIPT_DIR}/carpo_helper.py"
CONFIG_DIR="${HOME}/.config/carpo-helper"
CONFIG_PATH="${CONFIG_DIR}/config.json"
PLIST_LABEL="com.carpo.helper"
PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_PATH="${HOME}/Library/Logs/carpo-helper.log"

die() {
  echo "error: $*" >&2
  exit 1
}

if ! command -v python3 >/dev/null 2>&1; then
  die "python3 not found; install Python 3.10+"
fi

PYTHON_PATH="$(command -v python3)"

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "error: yt-dlp not found" >&2
  echo "hint: brew install yt-dlp" >&2
  echo "note: ffmpeg is required for --force-keyframes-at-cuts (included with the brew formula)" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "warning: ffmpeg not found on PATH; yt-dlp section cuts may fail without it" >&2
  echo "hint: brew install yt-dlp (pulls in ffmpeg)" >&2
fi

mkdir -p "${CONFIG_DIR}"

if [[ ! -f "${CONFIG_PATH}" ]]; then
  echo "Creating ${CONFIG_PATH}"
  read -r -p "Carpo base URL (e.g. https://carpo.example.com): " BASE_URL
  read -r -p "Helper token (HELPER_TOKEN from server): " HELPER_TOKEN
  read -r -p "Browser for cookies [chrome]: " BROWSER
  BROWSER="${BROWSER:-chrome}"
  "${PYTHON_PATH}" -c 'import sys; sys.path.insert(0, sys.argv[1]); from carpo_helper import render_config_json; print(render_config_json(sys.argv[2], sys.argv[3], sys.argv[4]))' \
    "${SCRIPT_DIR}" "${BASE_URL}" "${HELPER_TOKEN}" "${BROWSER}" > "${CONFIG_PATH}"
  chmod 600 "${CONFIG_PATH}"
  echo "Wrote ${CONFIG_PATH}"
else
  echo "Using existing config: ${CONFIG_PATH}"
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"

if launchctl print "gui/$(id -u)/${PLIST_LABEL}" >/dev/null 2>&1; then
  echo "Unloading existing ${PLIST_LABEL} agent"
  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || launchctl unload -w "${PLIST_PATH}" 2>/dev/null || true
fi

sed \
  -e "s|PYTHON_PATH|${PYTHON_PATH}|g" \
  -e "s|DAEMON_PATH|${DAEMON_PATH}|g" \
  -e "s|CONFIG_PATH|${CONFIG_PATH}|g" \
  -e "s|HOME_PATH|${HOME}|g" \
  "${SCRIPT_DIR}/com.carpo.helper.plist.template" > "${PLIST_PATH}"

echo "Installed ${PLIST_PATH}"

if launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}" 2>/dev/null; then
  echo "Loaded via launchctl bootstrap"
else
  launchctl load -w "${PLIST_PATH}"
  echo "Loaded via launchctl load -w"
fi

echo ""
echo "Carpo helper is running."
echo "  Logs: tail -f ${LOG_PATH}"
echo "  Test one job: python3 ${DAEMON_PATH} --config ${CONFIG_PATH} --once"
echo ""
echo "Uninstall:"
echo "  launchctl bootout gui/\$(id -u)/${PLIST_LABEL} 2>/dev/null || launchctl unload -w ${PLIST_PATH}"
echo "  rm ${PLIST_PATH}"
