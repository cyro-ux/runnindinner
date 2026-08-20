// Uit preview.html gelicht: inline <script> mag niet meer onder de CSP
// (script-src zonder 'unsafe-inline').
  // Sidebar navigation
  document.querySelectorAll('.sidebar-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('page-' + btn.dataset.page).classList.add('active');
    });
  });

  // Live CMS preview
  document.getElementById('cms-title').addEventListener('input', e => {
    document.getElementById('preview-title').textContent = e.target.value;
  });
  document.getElementById('cms-sub').addEventListener('input', e => {
    document.getElementById('preview-sub').textContent = e.target.value;
  });
  document.getElementById('cms-btn').addEventListener('input', e => {
    document.getElementById('preview-btn').textContent = e.target.value;
  });
