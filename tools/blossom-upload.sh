#!/bin/bash
# blossom-upload.sh - Upload file to Blossom with Nostr auth
#
# Usage: blossom-upload.sh <server-url> <file>
#
# Requires:
#   NOSTR_PRIVATE_KEY - 64-char hex private key
#   BLOSSOM_CLI_PATH  - path to blossom-cli binary (optional, defaults to 'blossom-cli')

SERVER="$1"
FILE="$2"

if [ -z "$SERVER" ] || [ -z "$FILE" ]; then
    echo "Usage: $0 <server-url> <file>" >&2
    exit 1
fi

if [ -z "$NOSTR_PRIVATE_KEY" ]; then
    echo "Error: NOSTR_PRIVATE_KEY not set" >&2
    exit 1
fi

if [ ! -f "$FILE" ]; then
    echo "Error: File not found: $FILE" >&2
    exit 1
fi

BLOSSOM_CLI="${BLOSSOM_CLI_PATH:-blossom-cli}"

if ! command -v "$BLOSSOM_CLI" &> /dev/null; then
    echo "Error: blossom-cli not found" >&2
    echo "Install it from: https://github.com/girino/blossom-cli?tab=readme-ov-file#installation" >&2
    echo "Or set BLOSSOM_CLI_PATH to the binary location" >&2
    exit 1
fi

"$BLOSSOM_CLI" upload -server "$SERVER" -file "$FILE" -privkey "$NOSTR_PRIVATE_KEY"
