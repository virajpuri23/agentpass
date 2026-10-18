/**
 * Newsletter helpers.
 *
 * SEEDED SECURITY ISSUE (documented in README.md): `confirmationHtml` builds
 * markup by concatenating the user-supplied name without escaping, and the
 * result is rendered with dangerouslySetInnerHTML. A name like
 * `<img src=x onerror=alert(1)>` executes in the visitor's browser (XSS).
 * The fix is `escapeHtml(name)`; the helper already exists below.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function confirmationHtml(name: string): string {
  return '<strong>Thanks, ' + name + '!</strong> Check your inbox to confirm.';
}
