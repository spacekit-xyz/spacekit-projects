#!/usr/bin/env bash
# Deploy Hermes messenger .spkg (wrapper — see deploy-app.sh).
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-app.sh" "$@"
