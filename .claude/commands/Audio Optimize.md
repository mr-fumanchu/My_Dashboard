# Audio Optimize

Automatically convert, compress, and deliver audio files in the best possible quality at the smallest file size. Handles any format, any size — no manual steps required.

## Usage
`/audio-optimize $ARGUMENTS`

Arguments can be:
- A file path: `/audio-optimize /path/to/file.wav`
- A glob pattern: `/audio-optimize *.wav`
- A directory: `/audio-optimize /path/to/folder`
- Empty (scans current working directory for audio files)

---

## What to do when this skill is invoked

### Step 1 — Identify target files

If `$ARGUMENTS` is a file path or pattern, resolve it. If empty, scan the current working directory for audio files matching extensions: `.wav .flac .aiff .aif .ogg .opus .m4a .wma .mp3 .aac .mp4 .webm .mkv`.

List what was found before proceeding.

### Step 2 — Ensure tools are available

Check for `ffmpeg` and `ffprobe`. If missing, install via:
```bash
apt-get install -y ffmpeg
```
Also ensure `p7zip-full` is available for fallback compression. Install if missing.

### Step 3 — Analyze each file

For every file found, use `ffprobe` to extract:
- Format / codec
- Duration
- Bitrate
- File size
- Sample rate / channels

```bash
ffprobe -v quiet -print_format json -show_format -show_streams "FILE"
```

Print a summary table of findings.

### Step 4 — Determine target format and bitrate

**Target format: MP3** (universally compatible).

Choose bitrate based on content type using this logic:
- If duration > 0 and the file appears to be speech/mono/low-frequency content → use **64 kbps**
- If source bitrate is ≤ 96 kbps → use **96 kbps** (no point upsampling)
- If source bitrate is ≤ 192 kbps → use **128 kbps**
- Otherwise → use **160 kbps**

For shamanic / meditative / drumming audio specifically, **128 kbps** is the sweet spot — enough fidelity, minimal size.

Estimated output size formula: `(bitrate_kbps / 8) * duration_seconds / 1024` = KB

### Step 5 — Convert and compress

Run ffmpeg conversion:
```bash
ffmpeg -i "INPUT" -codec:a libmp3lame -b:a BITRATEk -q:a 2 "OUTPUT.mp3" -y
```

Name the output file: same name as input, `.mp3` extension, in the same directory.

After conversion, print:
- Input size → Output size
- Compression ratio
- Estimated audio quality impact

### Step 6 — If the MP3 is still over 10 MB, apply 7z compression

```bash
7z a -t7z -mx=9 "OUTPUT.7z" "OUTPUT.mp3"
```

Compare sizes. If 7z is smaller, keep it and note the user will need 7-Zip to extract. If not meaningfully smaller (< 5% gain), skip it and keep the MP3.

### Step 7 — Attempt Google Drive upload

Search for a relevant Google Drive folder using the file name or context (e.g., if the file is shamanic drumming, look for "Shamanistic Audio"; otherwise look for a general "Audio" or "Music" folder, or upload to root).

Use the `mcp__b39edeed-8773-4466-b94e-a71bc7e34e55__search_files` and `mcp__b39edeed-8773-4466-b94e-a71bc7e34e55__create_file` tools.

**Upload size limit:** The Drive MCP tool can only handle files up to approximately **5 MB** as base64. Check file size before attempting:

```bash
stat -c%s "FILE"
```

- If ≤ 5 MB: read as base64 and upload directly.
- If > 5 MB: split into 5-minute segments using ffmpeg segment muxer, upload each segment individually with numbered names, and notify the user.

```bash
# Split into segments
ffmpeg -i "INPUT.mp3" -f segment -segment_time 300 -c copy "BASENAME_part%02d.mp3" -y
```

For each segment, base64 encode and upload:
```bash
base64 -w 0 "SEGMENT.mp3"
```

### Step 8 — Deliver via chat if Drive upload fails

If Drive upload fails for any reason, use SendUserFile to deliver the optimized file directly in the chat. Always deliver the final file — never leave the user with nothing.

### Step 9 — Clean up

If segments were created, offer to delete them after confirming everything uploaded successfully.

Update `.gitignore` in the project root to exclude any generated audio output files (`.mp3`, `.wav`, `.7z`, `*_part*.mp3`).

### Step 10 — Report

Print a clean summary:
```
✓ Input:   original_file.wav   (X MB, FORMAT, DURATION)
✓ Output:  original_file.mp3   (X MB, 128kbps MP3)
✓ Savings: X% size reduction
✓ Drive:   Uploaded to [Folder Name] — [link]
  OR
✓ Chat:    File delivered in chat — download and upload to Drive manually
```

---

## Key principles

- **Never leave the user empty-handed.** If one delivery method fails, try the next.
- **Never guess.** Use ffprobe to read actual file metadata before deciding on settings.
- **Preserve quality.** Don't downsample below the source's native quality.
- **Be transparent.** Always show before/after sizes and explain tradeoffs.
- **Be automatic.** Install missing tools, handle errors, retry — without asking the user to do it manually.
