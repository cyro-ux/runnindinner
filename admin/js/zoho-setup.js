// Uit zoho-setup.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
// Prefill code from URL fragment (safer than query string — fragment isn't sent to server)
(() => {
  const hash = location.hash.replace(/^#/, '');
  if (hash) document.getElementById('code').value = hash;
})();

const $ = (id) => document.getElementById(id);

async function doBootstrap(extraOrgId) {
  const btn = $('go'); btn.disabled = true;
  const result = $('result');
  result.style.display = 'none';

  const body = {
    clientId:     $('clientId').value.trim(),
    clientSecret: $('clientSecret').value.trim(),
    code:         $('code').value.trim(),
    region:       $('region').value,
    orgId:        extraOrgId || $('orgId').value.trim() || undefined,
  };

  try {
    const r = await fetch('/api/admin/zoho/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();

    if (d.needOrgSelection) {
      const picker = $('orgPicker');
      const list = $('orgList');
      list.innerHTML = d.organizations.map(o =>
        `<div style="padding:10px;border:1px solid #e2e8f0;border-radius:8px;margin-top:8px;cursor:pointer"
              onclick="doBootstrap('${o.id}')">
          <strong>${o.name}</strong> <span style="color:#64748b">(${o.id}, ${o.currency})</span>
        </div>`
      ).join('');
      picker.style.display = 'block';
      result.className = 'result';
      btn.disabled = false;
      return;
    }

    if (d.ok) {
      result.className = 'result ok';
      result.textContent = '✓ Gelukt! Organization ID: ' + d.orgId + '. Credentials opgeslagen in .env. Integratie is nu live — de eerstvolgende Mollie-betaling wordt automatisch naar Zoho Books gestuurd.';
      result.style.display = 'block';
    } else {
      result.className = 'result err';
      result.textContent = 'Mislukt: ' + (d.error || JSON.stringify(d.detail));
      result.style.display = 'block';
      btn.disabled = false;
    }
  } catch (err) {
    result.className = 'result err';
    result.textContent = 'Netwerkfout: ' + err.message;
    result.style.display = 'block';
    btn.disabled = false;
  }
}

$('go').addEventListener('click', () => doBootstrap());
window.doBootstrap = doBootstrap; // for inline onclick on orgList
