#!/usr/bin/env bash
# Deploy Janus workspaces .spkg (wrapper — see deploy-app.sh).
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-app.sh" "$@"
