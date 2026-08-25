#!/usr/bin/env bash
# Wipe the Firestore emulator so a demo starts from a clean slate.
set -euo pipefail
PROJECT="${FIREBASE_PROJECT_ID:-acn-local}"
HOST="${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8080}"
curl -sf -X DELETE "http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents" > /dev/null
echo "Firestore emulator data cleared for project ${PROJECT}."
