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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORIG_DIR="$(pwd)"

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 <blossom-url> <source-video> [title]"
    echo "Example: $0 http://localhost:3000 /path/to/video.mp4 'My Cool Video'"
    exit 1
fi

SERVER="$1"
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

# Check if video with this title already exists
echo "Checking if '$TITLE' already exists..."
existing=$(curl -s "$SERVER/videos" | jq -r --arg title "$TITLE" '.videos[] | select(.title == $title)')
if [ -n "$existing" ]; then
    echo "Error: Video with title '$TITLE' already exists:"
    echo "$existing" | jq .
    exit 1
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
"$SCRIPT_DIR/hls-upload.sh" "$SERVER" "$TITLE"

# Save hash to original directory
MASTER_HASH=$(cat master.m3u8.txt)
HASH_FILE="$ORIG_DIR/$TITLE.hash.txt"
echo "$MASTER_HASH" > "$HASH_FILE"

echo ""
echo "=== Done ==="
echo "Video '$TITLE' published successfully!"
echo "Master hash: $MASTER_HASH"
echo "Hash saved to: $HASH_FILE"
echo "URL: $SERVER/$MASTER_HASH"
