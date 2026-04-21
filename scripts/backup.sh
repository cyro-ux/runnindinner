#!/usr/bin/env bash
# backup.sh — dagelijkse backup van runningdinner.app
#
# Maakt een gecomprimeerde tarball van:
#   - SQLite database (data/app.db — met VACUUM INTO voor consistentie)
#   - .env
#   - content/blog/ (markdown-posts)
#   - CMS hero-images (uit cms.value als data:image — in DB)
#
# Upload optioneel naar Hetzner Storage Box via rclone als die is geconfigureerd.
#
# Retention: 30 dagen lokaal, 90 dagen op Storage Box.
#
# Gebruik (handmatig): ./scripts/backup.sh
# Gebruik (cron):      0 3 * * * /var/www/running-dinner/prod/scripts/backup.sh >> /var/log/rda-backup.log 2>&1

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
PROJECT_DIR="${PROJECT_DIR:-/var/www/running-dinner/prod}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/running-dinner}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"                  # leeg = geen remote sync
RCLONE_RETENTION_DAYS="${RCLONE_RETENTION_DAYS:-90}"

# ── Preconditions ───────────────────────────────────────────────────────────
[[ -d "$PROJECT_DIR" ]] || { echo "[backup] FAIL: $PROJECT_DIR not found"; exit 1; }
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

# ── SQLite consistent snapshot (VACUUM INTO) ────────────────────────────────
# Dit is de ENIGE veilige manier om een live SQLite te backuppen; kopiëren
# tijdens een schrijf kan corruptie geven.
if [[ -f "$PROJECT_DIR/data/app.db" ]]; then
  sqlite3 "$PROJECT_DIR/data/app.db" "VACUUM INTO '$TMPDIR/app.db'"
  echo "[backup] DB snapshot: $(du -h "$TMPDIR/app.db" | cut -f1)"
fi

# ── Kopieer overige bestanden (maar geen secrets in de repo) ────────────────
mkdir -p "$TMPDIR/config" "$TMPDIR/content"
[[ -f "$PROJECT_DIR/.env" ]]                   && cp "$PROJECT_DIR/.env"                   "$TMPDIR/config/.env"
[[ -d "$PROJECT_DIR/content/blog" ]]           && cp -r "$PROJECT_DIR/content/blog"        "$TMPDIR/content/"
[[ -f "$PROJECT_DIR/data/.zoho-token-cache.json" ]] \
  && cp "$PROJECT_DIR/data/.zoho-token-cache.json" "$TMPDIR/config/"

# ── Bouw tarball ────────────────────────────────────────────────────────────
BACKUP_FILE="$BACKUP_DIR/rda-backup-$TIMESTAMP.tar.gz"
tar -czf "$BACKUP_FILE" -C "$TMPDIR" .
chmod 0600 "$BACKUP_FILE"
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[backup] Created: $BACKUP_FILE ($SIZE)"

# ── Lokale retention: verwijder oude backups ────────────────────────────────
find "$BACKUP_DIR" -name 'rda-backup-*.tar.gz' -type f -mtime "+$RETENTION_DAYS" -delete
COUNT=$(find "$BACKUP_DIR" -name 'rda-backup-*.tar.gz' -type f | wc -l)
echo "[backup] Local backups: $COUNT files in $BACKUP_DIR"

# ── Sync naar Hetzner Storage Box (of een andere rclone-remote) ─────────────
if [[ -n "$RCLONE_REMOTE" ]] && command -v rclone >/dev/null 2>&1; then
  rclone copy "$BACKUP_FILE" "$RCLONE_REMOTE" --progress --no-traverse
  echo "[backup] Synced to $RCLONE_REMOTE"

  # Remote retention
  rclone lsl "$RCLONE_REMOTE" 2>/dev/null | awk '{print $4}' | while read -r f; do
    if [[ -n "$f" ]]; then
      # Parse YYYYMMDD-HHMMSS uit filename en check ouderdom
      ts=$(echo "$f" | grep -oP '\d{8}-\d{6}' || true)
      if [[ -n "$ts" ]]; then
        dt=$(date -d "${ts:0:4}-${ts:4:2}-${ts:6:2}" +%s 2>/dev/null || echo 0)
        age_days=$(( ( $(date +%s) - dt ) / 86400 ))
        if (( age_days > RCLONE_RETENTION_DAYS )); then
          rclone delete "$RCLONE_REMOTE/$f"
          echo "[backup] Pruned remote: $f ($age_days days old)"
        fi
      fi
    fi
  done
fi

echo "[backup] Done: $TIMESTAMP"
