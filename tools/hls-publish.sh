#!/bin/bash
#
# hls-publish.sh - Encode, upload, and register a video in one step
#
# Usage: hls-publish.sh <blossom-url> <source-video> [title]
#
# If title is not provided, defaults to the basename of the source video.
#
# Requires: BLOSSOM_ADMIN_PASS environment variable
#
# Creates <title>.hash.txt in the current directory containing the master hash.

set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORIG_DIR="$(pwd)"

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 <blossom-url> <source-video> [title]"
    echo "Example: $0 http://localhost:3000 /path/to/video.mp4 'My Cool Video'"
    exit 1
fi

SERVER="${1%/}"  # Remove trailing slash if present
SOURCE="$(realpath "$2")"
TITLE="${3:-$(basename "$SOURCE")}"

if [ ! -f "$SOURCE" ]; then
    echo "Error: Source video not found: $SOURCE"
    exit 1
fi

if [ -z "$BLOSSOM_ADMIN_PASS" ]; then
    echo "Error: BLOSSOM_ADMIN_PASS environment variable not set"
    exit 1
fi

if [ -z "$NOSTR_PRIVATE_KEY" ]; then
    echo "Error: NOSTR_PRIVATE_KEY environment variable not set"
    echo "Generate one with: openssl rand -hex 32"
    exit 1
fi

# Check if video with this source already exists (also verifies server is online)
echo "Checking server at $SERVER..."
{ curl -s "$SERVER/videos" | jq .videos > /dev/null; } || { echo "Error: Cannot connect to $SERVER"; exit 1; }
echo "Checking for existing video with source '$SOURCE'..."
existing_source=$(curl -s "$SERVER/videos" | jq -r --arg source "$SOURCE" '.videos[] | select(.source == $source)')
if [ -n "$existing_source" ]; then
    echo ""
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "!! WARNING: Video with same source already exists!    !!"
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "$existing_source" | jq .
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo ""
    echo "Proceeding anyway..."
    echo ""
fi

# Create temporary directory
TEMP_DIR=$(mktemp -d)
echo "Working in: $TEMP_DIR"

cleanup() {
    echo "Cleaning up temporary directory..."
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

cd "$TEMP_DIR"

# Encode
echo ""
echo "=== Encoding ==="
"$SCRIPT_DIR/hls-encode.sh" "$SOURCE"

# Upload and register
echo ""
echo "=== Uploading ==="
"$SCRIPT_DIR/hls-upload.sh" "$SERVER" "$TITLE" "$SOURCE"

# Save hash to original directory
MASTER_HASH=$(cat master.m3u8.txt)
WIDTH=$(cat width.txt)
HEIGHT=$(cat height.txt)
HASH_FILE="$ORIG_DIR/$TITLE.hash.txt"
echo "$MASTER_HASH" > "$HASH_FILE"

echo ""
echo ""
echo "=========================================================="
echo "                    PUBLISH COMPLETE                      "
echo "=========================================================="
echo ""
echo "  Title:       $TITLE"
echo "  Source:      $SOURCE"
echo "  Resolution:  ${WIDTH}x${HEIGHT}"
echo "  Master hash: $MASTER_HASH"
echo "  Hash file:   $HASH_FILE"
echo "  URL:         $SERVER/$MASTER_HASH"
echo ""
echo "=========================================================="
echo ""
