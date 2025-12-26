#!/bin/bash
#
# hls-upload.sh - Upload HLS content to Blossom server
#
# Usage: hls-upload.sh <blossom-url> <video-title> [source]
#
# Expects to be run from a directory created by hls-encode.sh containing:
#   hashed/              - directory of hash symlinks
#   master.m3u8.txt      - master playlist hash
#   duration.txt         - video duration in seconds
#   preview.jpg.txt      - preview thumbnail hash
#   sprite-meta.json.txt - sprite metadata hash
#
# Uploads all files from hashed/ to Blossom, verifies hashes,
# then registers the video with the given title.

set -e

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 <blossom-url> <video-title> [source]" >&2
    echo "Example: $0 http://localhost:3000 'My Cool Video' '/path/to/video.mp4'" >&2
    exit 1
fi

SERVER="$1"
TITLE="$2"
SOURCE="$3"
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
PREVIEW_HASH=$(cat preview.jpg.txt 2>/dev/null || echo "")
SPRITE_META_HASH=$(cat sprite-meta.json.txt 2>/dev/null || echo "")
WIDTH=$(cat width.txt 2>/dev/null || echo "")
HEIGHT=$(cat height.txt 2>/dev/null || echo "")
BLOB_COUNT=$(cat blob_count.txt 2>/dev/null || echo "")
TOTAL_SIZE=$(cat total_size.txt 2>/dev/null || echo "")
MAX_BLOB_SIZE=$(cat max_blob_size.txt 2>/dev/null || echo "")
QUALITY_STATS=$(cat quality_stats.json 2>/dev/null || echo "")

echo "Video title: $TITLE" >&2
echo "Master hash: $MASTER_HASH" >&2
echo "Duration: ${DURATION}s" >&2
[ -n "$WIDTH" ] && [ -n "$HEIGHT" ] && echo "Resolution: ${WIDTH}x${HEIGHT}" >&2
[ -n "$BLOB_COUNT" ] && echo "Blob count: $BLOB_COUNT" >&2
[ -n "$TOTAL_SIZE" ] && echo "Total size: $TOTAL_SIZE bytes" >&2
[ -n "$MAX_BLOB_SIZE" ] && echo "Max blob size: $MAX_BLOB_SIZE bytes" >&2
[ -n "$PREVIEW_HASH" ] && echo "Preview hash: $PREVIEW_HASH" >&2
[ -n "$SPRITE_META_HASH" ] && echo "Sprite meta hash: $SPRITE_META_HASH" >&2

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

# Build JSON payload
# Use jq to properly construct JSON with optional fields
JSON_PAYLOAD=$(jq -n \
    --arg title "$TITLE" \
    --arg master_hash "$MASTER_HASH" \
    --argjson duration "$DURATION" \
    --arg source "$SOURCE" \
    --arg preview_hash "$PREVIEW_HASH" \
    --arg sprite_meta_hash "$SPRITE_META_HASH" \
    --arg width "$WIDTH" \
    --arg height "$HEIGHT" \
    --arg blob_count "$BLOB_COUNT" \
    --arg total_size "$TOTAL_SIZE" \
    --arg max_blob_size "$MAX_BLOB_SIZE" \
    --arg quality_stats "$QUALITY_STATS" \
    '{
        title: $title,
        master_hash: $master_hash,
        duration: $duration,
        source: $source,
        preview_hash: $preview_hash,
        sprite_meta_hash: $sprite_meta_hash
    } + (if $width != "" then {width: ($width | tonumber)} else {} end)
      + (if $height != "" then {height: ($height | tonumber)} else {} end)
      + (if $blob_count != "" then {blob_count: ($blob_count | tonumber)} else {} end)
      + (if $total_size != "" then {total_size: ($total_size | tonumber)} else {} end)
      + (if $max_blob_size != "" then {max_blob_size: ($max_blob_size | tonumber)} else {} end)
      + (if $quality_stats != "" then {quality_stats: ($quality_stats | fromjson)} else {} end)'
)

http_code=$(curl -s -o /tmp/blossom_response.json -w "%{http_code}" \
    -u "$ADMIN_USER:$ADMIN_PASS" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$JSON_PAYLOAD" \
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
