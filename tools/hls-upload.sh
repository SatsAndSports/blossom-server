#!/bin/bash
#
# hls-upload.sh - Upload HLS content to Blossom server
#
# Usage: hls-upload.sh <blossom-url> <video-title>
#
# Expects to be run from a directory created by hls-encode.sh containing:
#   hashed/          - directory of hash symlinks
#   master.m3u8.txt  - master playlist hash
#   duration.txt     - video duration in seconds
#
# Uploads all files from hashed/ to Blossom, verifies hashes,
# then registers the video with the given title.

set -e

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 <blossom-url> <video-title>" >&2
    echo "Example: $0 http://localhost:3000 'My Cool Video'" >&2
    exit 1
fi

SERVER="$1"
TITLE="$2"
HASHED_DIR="hashed"

if [ ! -d "$HASHED_DIR" ]; then
    echo "Error: Directory not found: $HASHED_DIR" >&2
    echo "Run this from a directory created by hls-encode.sh" >&2
    exit 1
fi

if [ ! -f "master.m3u8.txt" ]; then
    echo "Error: master.m3u8.txt not found" >&2
    exit 1
fi

if [ ! -f "duration.txt" ]; then
    echo "Error: duration.txt not found" >&2
    exit 1
fi

MASTER_HASH=$(cat master.m3u8.txt)
DURATION=$(cat duration.txt)

echo "Video title: $TITLE" >&2
echo "Master hash: $MASTER_HASH" >&2
echo "Duration: ${DURATION}s" >&2

# Check if video with this title already exists
existing=$(curl -s "$SERVER/videos" | jq -r --arg title "$TITLE" '.videos[] | select(.title == $title)')
if [ -n "$existing" ]; then
    echo "Error: Video with title '$TITLE' already exists:" >&2
    echo "$existing" | jq . >&2
    exit 1
fi

# Count files
total=$(find "$HASHED_DIR" -maxdepth 1 -type l | wc -l)
count=0

echo "Uploading $total files to $SERVER" >&2
echo -n "Progress: " >&2

for file in "$HASHED_DIR"/*; do
    [ -e "$file" ] || continue

    expected=$(basename "$file")

    # Upload and capture response
    response=$(curl -s -X PUT --data-binary @"$file" "$SERVER/upload")

    # Extract returned hash
    returned=$(echo "$response" | jq -r '.sha256')

    if [ "$expected" != "$returned" ]; then
        echo "" >&2
        echo "HASH MISMATCH!" >&2
        echo "  File: $file" >&2
        echo "  Expected: $expected" >&2
        echo "  Returned: $returned" >&2
        echo "  Response: $response" >&2
        exit 1
    fi

    count=$((count + 1))
    echo -n "." >&2
done

echo " done" >&2
echo "Successfully uploaded $count files" >&2

# Register video with Blossom
echo "Registering video..." >&2

# Get admin credentials from config (or use defaults)
ADMIN_USER="${BLOSSOM_ADMIN_USER:-admin}"
ADMIN_PASS="${BLOSSOM_ADMIN_PASS:-}"

if [ -z "$ADMIN_PASS" ]; then
    echo "Error: BLOSSOM_ADMIN_PASS environment variable not set" >&2
    echo "Set it to the admin password from config.yml" >&2
    exit 1
fi

http_code=$(curl -s -o /tmp/blossom_response.json -w "%{http_code}" \
    -u "$ADMIN_USER:$ADMIN_PASS" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{\"title\": \"$TITLE\", \"master_hash\": \"$MASTER_HASH\", \"duration\": $DURATION}" \
    "$SERVER/api/videos")

response=$(cat /tmp/blossom_response.json)

if [ "$http_code" != "200" ]; then
    echo "Error registering video (HTTP $http_code): $response" >&2
    exit 1
fi

if ! echo "$response" | jq . > /dev/null 2>&1; then
    echo "Error: Invalid JSON response: $response" >&2
    exit 1
fi

echo "Video registered successfully!" >&2
echo "$response" | jq . >&2
