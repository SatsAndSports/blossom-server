#!/bin/bash
#
# hls-encode.sh - Encode video to HLS with hash-based naming
#
# Usage: hls-encode.sh <source-video>
#
# Creates in current directory:
#   720p/, 480p/, 360p/     - quality directories with segments
#   master.m3u8             - master playlist (references quality playlists by hash)
#   master.m3u8.txt         - contains the master playlist hash
#   duration.txt            - video duration in seconds
#   hashed/                 - flat directory of hash symlinks for Blossom upload
#     <sha256> -> ../720p/seg000.ts
#     <sha256> -> ../720p/playlist-hashed.m3u8
#     <sha256> -> ../master.m3u8
#
# Prints the master playlist hash on success.

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <source-video>" >&2
    exit 1
fi

SOURCE="$1"

if [ ! -f "$SOURCE" ]; then
    echo "Error: File not found: $SOURCE" >&2
    exit 1
fi

# Get video duration in seconds (rounded to integer)
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$SOURCE" | cut -d. -f1)
echo "Video duration: ${DURATION}s" >&2
echo "$DURATION" > duration.txt

# Quality levels: name resolution bitrate
QUALITIES=(
    "1080p 1920x1080 5000k"
    "720p 1280x720 2800k"
    "480p 854x480 1400k"
    "360p 640x360 800k"
    "240p 426x240 400k"
)

SEGMENT_DURATION=1

# Build a mapping of segment files to their hashes
declare -A SEG_TO_HASH

# Build a mapping of quality name to playlist hash
declare -A QUALITY_PLAYLIST_HASH

hash_file() {
    sha256sum "$1" | cut -d' ' -f1
}

# Create hashed directory for all symlinks
mkdir -p hashed

# Step 1: Encode each quality level
for quality in "${QUALITIES[@]}"; do
    read -r NAME RES BITRATE <<< "$quality"

    echo -n "Encoding $NAME ($RES @ $BITRATE) " >&2
    mkdir -p "$NAME"

    ffmpeg -i "$SOURCE" -y \
        -vf "scale=$RES" \
        -c:v libx264 -b:v "$BITRATE" \
        -g 30 -keyint_min 30 \
        -c:a aac -b:a 128k \
        -f hls \
        -hls_time "$SEGMENT_DURATION" \
        -hls_list_size 0 \
        -hls_segment_filename "$NAME/seg%03d.ts" \
        -progress pipe:1 \
        "$NAME/playlist.m3u8" \
        2>/dev/null | grep --line-buffered "^progress=" | while read -r line; do
            echo -n "." >&2
        done
    echo " done" >&2

    # Step 2: Create hash symlinks for segments in hashed/
    for seg in "$NAME"/seg*.ts; do
        if [ -f "$seg" ]; then
            hash=$(hash_file "$seg")
            segname=$(basename "$seg")
            ln -sf "../$NAME/$segname" "hashed/$hash"
            SEG_TO_HASH["$NAME/$segname"]="$hash"
        fi
    done
done

# Step 3: Rewrite quality playlists to use hash-based segment names
for quality in "${QUALITIES[@]}"; do
    read -r NAME _ _ <<< "$quality"

    echo "Rewriting $NAME playlist with hash references..." >&2

    # Read original playlist, replace segment references (no extension)
    while IFS= read -r line; do
        if [[ "$line" =~ ^seg[0-9]+\.ts$ ]]; then
            # This is a segment reference, replace with hash (no extension)
            hash="${SEG_TO_HASH["$NAME/$line"]}"
            echo "$hash"
        else
            # Keep line as-is (headers, durations, etc.)
            echo "$line"
        fi
    done < "$NAME/playlist.m3u8" > "$NAME/playlist-hashed.m3u8"

    # Hash the rewritten playlist and create symlink in hashed/
    playlist_hash=$(hash_file "$NAME/playlist-hashed.m3u8")
    ln -sf "../$NAME/playlist-hashed.m3u8" "hashed/$playlist_hash"
    QUALITY_PLAYLIST_HASH["$NAME"]="$playlist_hash"
    echo "  $NAME playlist: $playlist_hash" >&2
done

# Step 4: Generate master playlist referencing quality playlists by hash
echo "Generating master playlist..." >&2

cat > master.m3u8 << EOF
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
${QUALITY_PLAYLIST_HASH["1080p"]}
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
${QUALITY_PLAYLIST_HASH["720p"]}
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480
${QUALITY_PLAYLIST_HASH["480p"]}
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
${QUALITY_PLAYLIST_HASH["360p"]}
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240
${QUALITY_PLAYLIST_HASH["240p"]}
EOF

# Hash master playlist and create symlink in hashed/
MASTER_HASH=$(hash_file master.m3u8)
ln -sf "../master.m3u8" "hashed/$MASTER_HASH"

# Write master hash to a text file for easy reference
echo "$MASTER_HASH" > master.m3u8.txt

echo "Master playlist: $MASTER_HASH" >&2
echo ""
echo "$MASTER_HASH"
