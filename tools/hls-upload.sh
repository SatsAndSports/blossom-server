#!/bin/bash
#
# hls-upload.sh - Upload HLS content to Blossom server
#
# Usage: hls-upload.sh <blossom-url> [hashed-dir]
#
# Uploads all files from hashed/ directory to Blossom,
# verifying that returned hashes match filenames.

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <blossom-url> [hashed-dir]" >&2
    echo "Example: $0 http://localhost:3000 ./hashed" >&2
    exit 1
fi

SERVER="$1"
HASHED_DIR="${2:-hashed}"

if [ ! -d "$HASHED_DIR" ]; then
    echo "Error: Directory not found: $HASHED_DIR" >&2
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
