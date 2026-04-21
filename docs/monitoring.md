# Monitoring, backups & error-tracking

## Status

| Component | Status | Activatie |
|-----------|--------|-----------|
| Sentry error-tracking | Klaar (stille no-op zonder DSN) | Zet `SENTRY_DSN` in `.env` + `npm install @sentry/node` |
| Dagelijkse backup | Klaar (script) | Cron installeren op server |
| UptimeRobot | Endpoint klaar | Account maken bij uptimerobot.com + monitor toevoegen |

## Sentry activeren

1. Maak een account bij [sentry.io](https://sentry.io) (gratis tier = 5k events/maand)
2. Maak een nieuwe project, type **Node.js**
3. Kopieer de DSN
4. Op de server:
   ```bash
   cd /var/www/running-dinner/prod
   npm install --save-optional @sentry/node
   echo "SENTRY_DSN=https://xxx@sentry.io/yyy" >> .env
   pm2 restart running-dinner-prod
   ```
5. Verifieer: `lib/sentry.js` logt `[sentry] initialized` bij boot.

De app vangt ongehandelde Express-errors automatisch af als `app.use(sentry.errorHandler())` in server.js staat — momenteel nog uitgeschakeld totdat je Sentry activeert.

## Backup-cron installeren

```bash
# Als root op de Hetzner-server:
mkdir -p /var/backups/running-dinner
chmod 750 /var/backups/running-dinner

# Cron-entry
cat >> /etc/crontab <<'EOF'
# Daily backup of runningdinner.app at 03:00
0 3 * * * deploy /var/www/running-dinner/prod/scripts/backup.sh >> /var/log/rda-backup.log 2>&1
EOF
```

Eerste handmatige run:
```bash
sudo -u deploy /var/www/running-dinner/prod/scripts/backup.sh
```

Verwacht resultaat: een `.tar.gz` in `/var/backups/running-dinner/` met daarin:
- `app.db` — SQLite-snapshot via `VACUUM INTO` (consistent)
- `config/.env`, `config/.zoho-token-cache.json`
- `content/blog/*.md`

## Hetzner Storage Box voor remote backup (optioneel)

```bash
# Op de Hetzner-server
apt install -y rclone
rclone config  # → sftp → host=u123456.your-storagebox.de → user + pass

# In .env:
echo "RCLONE_REMOTE=storagebox:rda-backups" >> .env
echo "RCLONE_RETENTION_DAYS=90" >> .env
```

## UptimeRobot monitor

1. Maak account bij [uptimerobot.com](https://uptimerobot.com) (gratis tier = 50 monitors)
2. Add monitor:
   - Type: HTTPS
   - URL: `https://runningdinner.app/api/public/stats`
   - Interval: 5 min
   - Alerting: je eigen e-mailadres
3. Optioneel: status-page maken met een eigen subdomein (niet kritiek)

Het `/api/public/stats` endpoint is perfect voor monitoring — het faalt alleen als de app écht down is én het is snel/goedkoop.
