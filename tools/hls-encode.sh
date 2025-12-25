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

# Get source video height
SOURCE_HEIGHT=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=noprint_wrappers=1:nokey=1 "$SOURCE" | head -1 | tr -d '\n\r')
echo "Source height: ${SOURCE_HEIGHT}p" >&2

# All possible quality levels: name height bitrate
# We scale by height and auto-calculate width to preserve aspect ratio
ALL_QUALITIES=(
    "1080p 1080 5000k"
    "720p 720 2800k"
    "480p 480 1400k"
    "360p 360 800k"
    "240p 240 400k"
)

# Cap source height at 1080p for browser compatibility (H.264 level 4.1)
MAX_HEIGHT=1080
if [ "$SOURCE_HEIGHT" -gt "$MAX_HEIGHT" ]; then
    echo "Source exceeds ${MAX_HEIGHT}p, capping at ${MAX_HEIGHT}p" >&2
    EFFECTIVE_HEIGHT=$MAX_HEIGHT
else
    EFFECTIVE_HEIGHT=$SOURCE_HEIGHT
fi

# Filter to only include qualities <= effective height
# Also include the effective height itself if it doesn't match a standard level
QUALITIES=()
EFFECTIVE_HEIGHT_ADDED=false
for quality in "${ALL_QUALITIES[@]}"; do
    read -r NAME HEIGHT BITRATE <<< "$quality"
    if [ "$HEIGHT" -le "$EFFECTIVE_HEIGHT" ]; then
        QUALITIES+=("$quality")
        if [ "$HEIGHT" -eq "$EFFECTIVE_HEIGHT" ]; then
            EFFECTIVE_HEIGHT_ADDED=true
        fi
    fi
done

# If effective height is non-standard (e.g., 500p), add it as the top quality
if [ "$EFFECTIVE_HEIGHT_ADDED" = false ]; then
    # Estimate bitrate based on height (roughly linear interpolation)
    if [ "$EFFECTIVE_HEIGHT" -gt 720 ]; then
        BITRATE="4000k"
    elif [ "$EFFECTIVE_HEIGHT" -gt 480 ]; then
        BITRATE="2000k"
    elif [ "$EFFECTIVE_HEIGHT" -gt 360 ]; then
        BITRATE="1000k"
    else
        BITRATE="600k"
    fi
    QUALITIES=("${EFFECTIVE_HEIGHT}p $EFFECTIVE_HEIGHT $BITRATE" "${QUALITIES[@]}")
fi

echo "Encoding qualities: ${QUALITIES[*]}" >&2

SEGMENT_DURATION=1

# Build a mapping of segment files to their hashes
declare -A SEG_TO_HASH

# Build a mapping of quality name to playlist hash
declare -A QUALITY_PLAYLIST_HASH

# Build a mapping of quality name to actual resolution
declare -A QUALITY_RESOLUTION

hash_file() {
    sha256sum "$1" | cut -d' ' -f1
}

# Create hashed directory for all symlinks
mkdir -p hashed

# Step 1: Encode each quality level
for quality in "${QUALITIES[@]}"; do
    read -r NAME HEIGHT BITRATE <<< "$quality"

    echo -n "Encoding $NAME (height=$HEIGHT @ $BITRATE) " >&2
    mkdir -p "$NAME"

    ffmpeg -i "$SOURCE" -y \
        -vf "scale=-2:$HEIGHT,format=yuv420p" \
        -c:v libx264 -profile:v high -level 4.1 -b:v "$BITRATE" \
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

    # Get actual resolution from first segment
    ACTUAL_WIDTH=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=noprint_wrappers=1:nokey=1 "$NAME/seg000.ts" | head -1 | tr -d '\n\r')
    ACTUAL_HEIGHT=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=noprint_wrappers=1:nokey=1 "$NAME/seg000.ts" | head -1 | tr -d '\n\r')
    QUALITY_RESOLUTION["$NAME"]="${ACTUAL_WIDTH}x${ACTUAL_HEIGHT}"
    echo "  Actual resolution: ${ACTUAL_WIDTH}x${ACTUAL_HEIGHT}" >&2

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

# Store resolution of highest quality (first in QUALITIES array) for video metadata
read -r TOP_QUALITY _ _ <<< "${QUALITIES[0]}"
VIDEO_WIDTH=$(echo "${QUALITY_RESOLUTION["$TOP_QUALITY"]}" | cut -d'x' -f1)
VIDEO_HEIGHT=$(echo "${QUALITY_RESOLUTION["$TOP_QUALITY"]}" | cut -d'x' -f2)

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

# Build master playlist dynamically based on encoded qualities
echo "#EXTM3U" > master.m3u8
for quality in "${QUALITIES[@]}"; do
    read -r NAME HEIGHT BITRATE <<< "$quality"
    # Convert bitrate string (e.g., "5000k") to number (e.g., 5000000)
    BW_NUM=$(echo "$BITRATE" | sed 's/k$/000/')
    echo "#EXT-X-STREAM-INF:BANDWIDTH=${BW_NUM},RESOLUTION=${QUALITY_RESOLUTION["$NAME"]}" >> master.m3u8
    echo "${QUALITY_PLAYLIST_HASH["$NAME"]}" >> master.m3u8
done

# Hash master playlist and create symlink in hashed/
MASTER_HASH=$(hash_file master.m3u8)
ln -sf "../master.m3u8" "hashed/$MASTER_HASH"

# Write master hash to a text file for easy reference
echo "$MASTER_HASH" > master.m3u8.txt

echo "Master playlist: $MASTER_HASH" >&2

# Step 5: Generate preview thumbnail (best frame for video list)
echo -n "Generating preview thumbnail... " >&2
ffmpeg -i "$SOURCE" -y \
    -vf "thumbnail=n=100,scale=280:-1:flags=lanczos" \
    -frames:v 1 \
    -q:v 5 \
    preview.jpg \
    2>/dev/null
PREVIEW_HASH=$(hash_file preview.jpg)
ln -sf "../preview.jpg" "hashed/$PREVIEW_HASH"
echo "$PREVIEW_HASH" > preview.jpg.txt
echo "done ($PREVIEW_HASH)" >&2

# Step 6: Generate sprite sheet (thumbnails for progress bar scrubbing)
echo -n "Generating sprite sheet... " >&2
SPRITE_INTERVAL=5
SPRITE_COLUMNS=10
SPRITE_THUMB_WIDTH=160
SPRITE_THUMB_HEIGHT=90

# Calculate rows needed based on duration
SPRITE_FRAMES=$(( (DURATION + SPRITE_INTERVAL - 1) / SPRITE_INTERVAL ))
SPRITE_ROWS=$(( (SPRITE_FRAMES + SPRITE_COLUMNS - 1) / SPRITE_COLUMNS ))

ffmpeg -i "$SOURCE" -y \
    -vf "fps=1/$SPRITE_INTERVAL,scale=${SPRITE_THUMB_WIDTH}:${SPRITE_THUMB_HEIGHT}:force_original_aspect_ratio=decrease,pad=${SPRITE_THUMB_WIDTH}:${SPRITE_THUMB_HEIGHT}:(ow-iw)/2:(oh-ih)/2,tile=${SPRITE_COLUMNS}x${SPRITE_ROWS}" \
    -frames:v 1 \
    -q:v 5 \
    sprite.jpg \
    2>/dev/null
SPRITE_HASH=$(hash_file sprite.jpg)
ln -sf "../sprite.jpg" "hashed/$SPRITE_HASH"
echo "$SPRITE_HASH" > sprite.jpg.txt

# Write sprite metadata for the player
cat > sprite-meta.json << EOF
{
    "sprite_hash": "$SPRITE_HASH",
    "interval": $SPRITE_INTERVAL,
    "columns": $SPRITE_COLUMNS,
    "thumb_width": $SPRITE_THUMB_WIDTH,
    "thumb_height": $SPRITE_THUMB_HEIGHT,
    "rows": $SPRITE_ROWS,
    "frames": $SPRITE_FRAMES
}
EOF

# Hash and symlink sprite-meta.json for upload
SPRITE_META_HASH=$(hash_file sprite-meta.json)
ln -sf "../sprite-meta.json" "hashed/$SPRITE_META_HASH"
echo "$SPRITE_META_HASH" > sprite-meta.json.txt
echo "done (sprite: $SPRITE_HASH, meta: $SPRITE_META_HASH)" >&2

# Write resolution to file for easy reference
echo "$VIDEO_WIDTH" > width.txt
echo "$VIDEO_HEIGHT" > height.txt
echo "Video resolution: ${VIDEO_WIDTH}x${VIDEO_HEIGHT}" >&2

# Calculate blob statistics
BLOB_COUNT=$(find hashed -maxdepth 1 -type l | wc -l)
TOTAL_SIZE=0
MAX_BLOB_SIZE=0
for file in hashed/*; do
    [ -e "$file" ] || continue
    size=$(stat -L -c%s "$file")
    TOTAL_SIZE=$((TOTAL_SIZE + size))
    if [ "$size" -gt "$MAX_BLOB_SIZE" ]; then
        MAX_BLOB_SIZE=$size
    fi
done
echo "$BLOB_COUNT" > blob_count.txt
echo "$TOTAL_SIZE" > total_size.txt
echo "$MAX_BLOB_SIZE" > max_blob_size.txt
echo "Blob stats: count=$BLOB_COUNT total=${TOTAL_SIZE} bytes max=${MAX_BLOB_SIZE} bytes" >&2

echo ""
echo "$MASTER_HASH"
