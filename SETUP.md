# Running Dinner Planner – Installatie & Deploymentgids
<!-- Deployed at runningdiner.nl -->

## Vereisten

- **Node.js** ≥ 18 (aanbevolen: LTS via [nodejs.org](https://nodejs.org))
- **npm** ≥ 9
- **Een Linux VPS of cloud-server** met SSH-toegang (Ubuntu 22.04 aanbevolen)
- **Een domeinnaam** (`runningdiner.nl` – geregistreerd bij Argeweb)
- **Mollie-account** (maak aan op [mollie.com](https://mollie.com))
- **SMTP-account** voor e-mail (bijv. Brevo, Mailgun of Gmail App Password)

---

## 1. Eerste keer installeren

### 1.1 Bestanden op de server plaatsen

```bash
# Verbind via SSH
ssh gebruiker@jouw-server-ip

# Maak map aan en kopieer bestanden
mkdir -p /var/www/running-dinner
cd /var/www/running-dinner
# Upload alle projectbestanden via scp, rsync of git clone
```

### 1.2 Dependencies installeren

```bash
cd /var/www/running-dinner
npm install --production
```

### 1.3 Omgevingsvariabelen instellen

```bash
cp .env.example .env
nano .env   # Vul alle waarden in (zie opmerkingen hieronder)
```

**Minimale vereiste instellingen in `.env`:**

| Variabele | Beschrijving |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` (productie) |
| `JWT_SECRET` | Lange willekeurige string (min. 32 tekens) |
| `ADMIN_EMAIL` | E-mailadres van de beheerder |
| `ADMIN_PASSWORD` | Sterk wachtwoord (wordt gehasht bij eerste start) |
| `MOLLIE_API_KEY` | Mollie live API key (`live_...`) |
| `SMTP_HOST` | SMTP-server voor e-mail |
| `BASE_URL` | `https://runningdiner.nl` |

### 1.4 Database-map aanmaken

```bash
mkdir -p /var/www/running-dinner/data
```

---

## 2. Draaien met PM2 (procesbeheer)

PM2 zorgt dat de server automatisch herstart bij crashes en bij het opstarten van de server.

```bash
# PM2 installeren (eenmalig)
npm install -g pm2

# Applicatie starten
pm2 start server.js --name "running-dinner-prod" --env production

# Automatisch starten bij herstart server
pm2 startup
pm2 save

# Logs bekijken
pm2 logs running-dinner-prod

# Herstart na code-update
pm2 reload running-dinner-prod
```

---

## 3. Nginx als reverse proxy + HTTPS

### 3.1 Nginx installeren

```bash
sudo apt update
sudo apt install nginx -y
```

### 3.2 Nginx configuratie

Maak een nieuw configuratiebestand:

```bash
sudo nano /etc/nginx/sites-available/running-dinner
```

Plak de volgende configuratie (vervang `runningdiner.nl` door je echte domeinnaam):

```nginx
server {
    listen 80;
    server_name runningdiner.nl www.runningdiner.nl;

    # Certbot zal dit omleiden naar HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name runningdiner.nl www.runningdiner.nl;

    # SSL (aangemaakt door Certbot – zie stap 3.3)
    ssl_certificate     /etc/letsencrypt/live/runningdiner.nl/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/runningdiner.nl/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Beveiligingsheaders
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript;

    # Mollie webhook
    location /api/mollie/webhook {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
    }

    # Alle andere verzoeken
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Activeer de configuratie:

```bash
sudo ln -s /etc/nginx/sites-available/running-dinner /etc/nginx/sites-enabled/
sudo nginx -t         # Controleer op syntaxfouten
sudo systemctl reload nginx
```

### 3.3 HTTPS via Let's Encrypt (Certbot)

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d runningdiner.nl -d www.runningdiner.nl
# Volg de instructies; kies "2" om verkeer automatisch om te leiden naar HTTPS
```

Het certificaat wordt automatisch elke 60 dagen vernieuwd via een systemd timer.

---

## 4. Mollie Webhook instellen

De webhook URL wordt automatisch door de server geconfigureerd op basis van de `BASE_URL` in `.env`.

1. Ga naar [mollie.com/dashboard](https://mollie.com/dashboard) → **Developers** → **API keys**
2. Kopieer de **Live API key** (`live_...`) en zet die in `.env` als `MOLLIE_API_KEY`
3. Zorg dat `BASE_URL` in `.env` goed staat: `https://runningdiner.nl`
4. De webhook endpoint is: `https://runningdiner.nl/api/mollie/webhook`
5. Herstart de server: `pm2 reload running-dinner-prod`

**Test mode:** Gebruik `test_...` API key in `.env.acc` voor de acceptatieomgeving.

---

## 5. Acceptatie en Productie omgevingen

De applicatie draait in twee omgevingen op dezelfde server:

| Omgeving | Poort | PM2-naam | .env-bestand | URL |
|---|---|---|---|---|
| Productie | 3000 | `running-dinner-prod` | `.env` | `runningdiner.nl` |
| Acceptatie | 3001 | `running-dinner-acc` | `.env.acc` | `acc.runningdiner.nl` |

### Acceptatieomgeving opzetten:

```bash
# Aparte clone in /var/www/running-dinner/acc/
cd /var/www/running-dinner/acc
cp .env.example .env.acc
# Pas .env.acc aan: PORT=3001, MOLLIE_API_KEY=test_..., BASE_URL=https://acc.runningdiner.nl
pm2 start server.js --name "running-dinner-acc" --cwd /var/www/running-dinner/acc
```

Voeg voor de acceptatieomgeving een extra Nginx server block toe op `acc.runningdiner.nl` met Basic Auth (zie deployment plan).

---

## 6. Updates uitrollen

```bash
# 1. Kopieer nieuwe bestanden naar de server (scp/rsync/git pull)
# 2. Dependencies bijwerken (indien nodig)
npm install --production

# 3. Server herstarten
pm2 reload running-dinner-prod

# 4. Controleer logs
pm2 logs running-dinner-prod --lines 50
```

Via de adminpanel kun je deployments ook registreren via de **Deployment** pagina (`/admin/`).

---

## 7. Back-up

De SQLite-database staat in `./data/app.db`. Maak dagelijkse back-ups:

```bash
# Handmatig back-up
sqlite3 /var/www/running-dinner/data/app.db ".backup '/backup/app-$(date +%Y%m%d).db'"

# Of stel een cron job in:
# 0 3 * * * sqlite3 /var/www/running-dinner/data/app.db ".backup '/backup/app-$(date +\%Y\%m\%d).db'"
```

---

## 8. Firewall

```bash
sudo ufw allow 22    # SSH
sudo ufw allow 80    # HTTP
sudo ufw allow 443   # HTTPS
sudo ufw deny 3000   # Blokkeer directe toegang tot Node.js-poorten
sudo ufw deny 3001
sudo ufw enable
```

---

## 9. Bestandsstructuur

```
/var/www/running-dinner/
├── index.html          ← Running Dinner Planner app (beschikbaar op /app)
├── style.css
├── app.js
├── server.js           ← Express server
├── package.json
├── .env                ← Geheimen (NIET in git!)
├── .env.example        ← Template (WEL in git)
├── data/
│   └── app.db          ← SQLite database (NIET in git!)
├── public/             ← Statische bestanden (homepage, auth-pagina's)
│   ├── home.html
│   ├── home.css
│   ├── login.html
│   ├── register.html
│   ├── forgot-password.html
│   ├── reset-password.html
│   ├── subscribe.html
│   └── payment-success.html
└── admin/
    └── index.html      ← Adminpanel (beschikbaar op /admin/)
```

---

## 10. .gitignore

Voeg het volgende toe aan `.gitignore` als je git gebruikt:

```
.env
.env.acc
.env.dev
data/
data-acc/
node_modules/
```
