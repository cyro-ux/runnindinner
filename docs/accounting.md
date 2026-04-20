# Boekhouding-integratie — runningdinner.app × Zoho Books

Deze module synchroniseert elke succesvolle Mollie-betaling naar Zoho Books als factuur. De integratie is beschreven in requirements-document sectie 14a en wordt geactiveerd zodra de OAuth-credentials in de servervariabelen staan.

## Architectuur

```
Mollie webhook  ──►  /api/mollie/webhook
                          │
                          │ INSERT INTO payments (status='paid')
                          ▼
                     zoho-sync.syncPayment()
                          │
                          ├─► VatResolver (bepaalt tarief + regeling)
                          ├─► zoho-client.findCustomerByEmail / createCustomer
                          ├─► zoho-client.createInvoice
                          └─► zoho-client.recordPayment
                                    │
                                    ▼
                          payments.zoho_invoice_id = "..."
                          payments.zoho_sync_status = 'synced'
```

## Modules

| Bestand | Verantwoordelijkheid |
|---------|----------------------|
| `lib/vat-resolver.js` | Bepaalt BTW-tarief en fiscale regeling per klant (NL/EU-B2C/EU-B2B/UK/Export) |
| `lib/vies.js` | Valideert EU VAT-ID's via de VIES-service (voor reverse-charge) |
| `lib/zoho-client.js` | OAuth 2.0 + REST-wrapper voor Zoho Books API v3 |
| `lib/zoho-sync.js` | Orchestreert payment → customer → invoice → payment-record |

## Database

Twee tabellen zijn uitgebreid met Zoho-velden:

**`users`**:
- `country` — ISO-3166 landcode van de klant
- `is_business` — 0 of 1
- `vat_id` — EU VAT-ID, inclusief landprefix ("DE123456789")
- `vat_id_valid` — 0 of 1 (resultaat van VIES-check)
- `company_name` — bedrijfsnaam voor zakelijke klanten
- `zoho_customer_id` — Zoho's contact_id (opgeslagen bij eerste factuur)

**`payments`**:
- `vat_rate` — percentage toegepast (bijv. 21.0, 19.0, 0.0)
- `vat_scheme` — 'DOMESTIC' / 'OSS' / 'REVERSE_CHARGE' / 'UK' / 'EXPORT'
- `country` — snapshot op moment van betaling (klant kan verhuizen)
- `zoho_invoice_id` — Zoho's invoice_id
- `zoho_sync_status` — 'pending' (default) / 'synced' / 'failed' / 'skipped'
- `zoho_sync_error` — laatste foutbericht bij failed status
- `zoho_synced_at` — timestamp van succesvolle sync

## BTW-logica

| Scenario | Tarief | Regeling | Noot op factuur |
|----------|--------|----------|-----------------|
| NL-klant (consument of zakelijk) | 21% | DOMESTIC | — |
| EU-consument (B2C) | Lokaal tarief (17%-27%) | OSS | — |
| EU-zakelijk met geldig VAT-ID | 0% | REVERSE_CHARGE | "BTW verlegd, artikel 44 BTW-richtlijn 2006/112/EG" |
| EU-zakelijk zonder (geldig) VAT-ID | Lokaal tarief | OSS | (behandeld als B2C) |
| Verenigd Koninkrijk | 0% | UK | "Outside scope of UK VAT (non-established)" |
| Non-EU (VS/CA/AU/NZ/LatAm/…) | 0% | EXPORT | "Export van digitale dienst buiten de EU" |

De tarieven staan in `lib/vat-resolver.js` en moeten **jaarlijks door de accountant worden gecontroleerd**. Unit-tests in `lib/vat-resolver.test.js` garanderen dat elke regeling correct wordt toegepast.

## Configuratie

### Server-side environment variables

Vereist om de integratie te activeren:

```env
ZOHO_CLIENT_ID=1000.XXXXXXXXXXXXXXXXXXXXXXXX
ZOHO_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ZOHO_REFRESH_TOKEN=1000.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxx
ZOHO_ORG_ID=12345678
ZOHO_REGION=com
```

`ZOHO_REGION` wordt gebruikt om de juiste API-endpoints te kiezen:
- `com` → `accounts.zoho.com` + `www.zohoapis.com` (US/global; huidige keuze)
- `eu` → `accounts.zoho.eu` + `www.zohoapis.eu` (EU-datacenter)
- `in` → `accounts.zoho.in` (India)
- `com.au` → `accounts.zoho.com.au` (Australië)

### Zoho-zijde opzet (eenmalig)

Volg blok B tot en met H van de opstart-checklist (requirements sectie 14b):

1. **Datacenter** = afhankelijk van waar je Zoho-account is aangemaakt.
   Runningdinner.app zit op `zoho.com` (reeds 1,5 jaar in gebruik voor meerdere
   ondernemingen). AVG-compliance wordt afgedekt via Zoho's Standard
   Contractual Clauses (SCC) en Data Processing Addendum (DPA) — eenmalig te
   accepteren onder *Organization Profile → Compliance*.
2. **Professional plan** actief
3. **Tax codes** aangemaakt voor:
   - `NL_STANDARD_21` — NL 21%
   - `OSS_DE_19`, `OSS_FR_20`, … — per EU-land
   - `EU_REVERSE_CHARGE` — 0% met verlegde BTW
   - `UK_ZERO` — 0% (buiten UK VAT-scope)
   - `EXPORT_ZERO` — 0% export
4. **Multi-currency**: EUR (basis) + GBP + USD + CAD + AUD + NZD
5. **Dedicated API-gebruiker** (`api@runningdinner.app`) aangemaakt met rol Admin
6. **OAuth Self-Client** bij [api-console.zoho.com](https://api-console.zoho.com) (of `.eu`, afhankelijk van datacenter) met scopes:
   - `ZohoBooks.invoices.ALL`
   - `ZohoBooks.customers.ALL`
   - `ZohoBooks.creditnotes.ALL`
   - `ZohoBooks.customerpayments.ALL`
   - `ZohoBooks.settings.READ`

## Monitoring & herstel

### Admin dashboard
Tab **Boekhouding** in `/admin/` toont:
- Verbindingsstatus (groen = configured)
- Aantallen per sync-status (synced/pending/failed/skipped)
- Laatste 50 transacties met BTW-tarief, regeling en Zoho-invoice-id
- Retry-knop per gefaalde transactie

### Dagelijkse reconciliation
De server draait dagelijks (02:00 productie) `reconcileZoho()`:
- Zoekt betaalde transacties van de laatste 7 dagen zonder `zoho_invoice_id`
- Probeert opnieuw te synchroniseren, met 1 seconde delay tussen calls
- Logt succes en mislukking naar stdout (en Sentry zodra geïntegreerd)

### Handmatige herstart na Zoho-downtime
```bash
# Op de server:
curl -X POST https://runningdiner.nl/api/admin/zoho/retry/<paymentId> \
  -H "Cookie: token=<admin-token>"
```

## Accountant-toegang

- Accountant krijgt in Zoho Books een gebruiker met rol **Accountant** of **View-only**
- Voor OSS-aangifte: *Reports → VAT Summary → EU VAT (MOSS)* per kwartaal
- Voor jaarafsluiting: alle facturen en creditnota's zijn direct uit Zoho op te halen
- runningdinner.app zelf is **géén** boekhouding — het is de bron, Zoho is de registratie

## Kosten-zijde (expenses)

Buiten deze integratie om: Hetzner, Brevo, Cloudflare, Argeweb en Mollie-transactiekosten worden via Zoho's **e-mail-in-box** (blok I van 14b-checklist) verwerkt. Factuur-mails worden automatisch doorgestuurd naar `bills@runningdinner.books.zoho.eu`.

## Testen

```bash
# VatResolver unit-tests
node --test lib/vat-resolver.test.js

# VIES parser tests
node --test lib/vies.test.js

# End-to-end (na configuratie):
# 1. Verricht een test-betaling via Mollie's test-mode (ENV=staging)
# 2. Check /admin/ → Boekhouding → transactie moet binnen 30s op 'synced' staan
```

## Bekende beperkingen

- Wisselkoersen voor multi-currency volgen Zoho's dagelijkse rates; verschilt soms 0,1-0,5% met Mollie
- VIES-validatie is conservatief: bij API-downtime wordt VAT-ID als niet-gevalideerd behandeld (klant betaalt dan lokaal BTW-tarief)
- Geen sync van abonnements-status naar Zoho's Subscriptions-module — alleen losse invoices per betaling
