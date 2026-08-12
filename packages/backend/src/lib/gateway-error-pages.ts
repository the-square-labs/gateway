const pageShell = (title: string, heading: string, message: string, status: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>${title}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#fff;color:#09090b;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:100%;max-width:560px;text-align:center}.status{color:#71717a;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}h1{margin:16px 0 0;font-size:clamp(40px,8vw,64px);line-height:1.05;font-weight:700;letter-spacing:-.04em}p.message{margin:20px auto 0;max-width:440px;color:#71717a;font-size:15px;line-height:1.6}.footer{margin-top:48px;color:#71717a;font-size:12px}.footer a{color:inherit;text-decoration:none}.footer a:hover{text-decoration:underline}@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}.status,p.message,.footer{color:#a1a1aa}.footer a{color:#fafafa}}</style></head><body><main><section><div class="status">${status}</div><h1>${heading}</h1><p class="message">${message}</p></section><div class="footer">Powered by <a href="https://wiolett.net" rel="noopener noreferrer">Wiolett Industries</a></div></main></body></html>`;

export const GATEWAY_NOT_FOUND_HTML = pageShell(
  'Page not found',
  'Page not found',
  'The requested host or page is not available.',
  'Error 404'
);

export const GATEWAY_MAINTENANCE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>Maintenance in progress</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#fff;color:#09090b;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:100%;max-width:560px;text-align:center}.status{color:#71717a;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}h1{margin:16px 0 0;font-size:clamp(40px,8vw,64px);line-height:1.05;font-weight:700;letter-spacing:-.04em}p.message{margin:20px auto 0;max-width:440px;color:#71717a;font-size:15px;line-height:1.6}.footer{margin-top:48px;color:#71717a;font-size:12px}.footer a,.access{color:inherit;text-decoration:none}.footer a:hover,.access:hover{text-decoration:underline}@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}.status,p.message,.footer{color:#a1a1aa}.footer a,.access{color:#fafafa}}</style></head><body><main><section><div class="status">Error 503</div><h1>Maintenance in progress</h1><p class="message">This service is temporarily unavailable while scheduled work is completed. Please try again later.</p></section><div class="footer"><a class="access" href="#access" id="maintenance-access-link">Team access</a><span aria-hidden="true"> · </span>Powered by <a href="https://wiolett.net" rel="noopener noreferrer">Wiolett Industries</a></div></main><script>(()=>{const link=document.getElementById('maintenance-access-link');link.addEventListener('click',async e=>{e.preventDefault();const code=window.prompt('Access code')?.trim();if(!code)return;try{const r=await fetch('/_gateway/maintenance-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});if(r.status===204)window.location.reload()}catch{}})})();</script></body></html>`;

const EXTERNAL_BRANDING_HTML =
  'Powered by <a href="https://wiolett.net" rel="noopener noreferrer">Wiolett Industries</a>';

export function gatewayNotFoundHtml(hideExternalBranding = false): string {
  if (!hideExternalBranding) return GATEWAY_NOT_FOUND_HTML;
  return GATEWAY_NOT_FOUND_HTML.replace(`<div class="footer">${EXTERNAL_BRANDING_HTML}</div>`, '');
}

export function gatewayMaintenanceHtml(hideExternalBranding = false): string {
  if (!hideExternalBranding) return GATEWAY_MAINTENANCE_HTML;
  return GATEWAY_MAINTENANCE_HTML.replace(`<span aria-hidden="true"> · </span>${EXTERNAL_BRANDING_HTML}`, '');
}

export const GATEWAY_RESTARTING_SCRIPT = `(() => {
  const check = async () => {
    try {
      const response = await fetch('/health', { cache: 'no-store' });
      if (response.ok) {
        const health = await response.json();
        if (health.lifecycleState === 'running') {
          window.location.reload();
          return;
        }
      }
    } catch {}
    window.setTimeout(check, 1000);
  };
  void check();
})();`;

export const GATEWAY_RESTARTING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <meta name="color-scheme" content="dark">
    <title>Restarting Gateway</title>
    <style>
      *{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#090909;color:#f4f4f5;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.content{width:100%;max-width:384px;text-align:center}.icon{display:flex;width:48px;height:48px;margin:0 auto 16px;align-items:center;justify-content:center;border:1px solid rgba(234,179,8,.35);background:rgba(234,179,8,.06);color:#facc15}.spinner{width:24px;height:24px;animation:spin .9s linear infinite}h1{margin:0;font-size:18px;line-height:1.4;font-weight:600}p{margin:8px 0 0;color:#a1a1aa;font-size:14px;line-height:1.55}.footer{margin-top:28px;color:#71717a;font-size:12px}.footer a{color:#a1a1aa;text-decoration:none}.footer a:hover{text-decoration:underline}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation-duration:1.8s}}
    </style>
    <script src="/gateway-restarting.js" defer></script>
  </head>
  <body>
    <main class="content">
      <div class="icon" aria-hidden="true"><svg class="spinner" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg></div>
      <h1>Restarting Gateway</h1>
      <p>Gateway is finishing active work before restarting. New actions are temporarily locked.</p>
      <div class="footer">Powered by <a href="https://wiolett.net" rel="noopener noreferrer">Wiolett Industries</a></div>
    </main>
  </body>
</html>`;

export function escapeNginxReturnText(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\$/g, '\\$')
    .replace(/[\r\n]+/g, ' ')}'`;
}
