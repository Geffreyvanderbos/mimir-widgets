/**
 * Copy text, three ways, because one is not enough from inside an iframe.
 *
 * The async Clipboard API is the happy path, but these pages run cross-origin
 * inside someone else's app, where a `Permissions-Policy` that omits
 * `clipboard-write` rejects the promise outright. The deprecated `execCommand`
 * path isn't gated that way, so it's the fallback — and if both fail, the text
 * is left selected so a manual ⌘C still works.
 *
 * Returns whether the text made it to the clipboard, so a caller can say
 * "Copied" or "Press ⌘C" truthfully rather than claiming success either way.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.className = 'copy-scratch';
    document.body.append(scratch);
    scratch.select();
    try {
      if (document.execCommand('copy')) return true;
    } catch {
      // Fall through to leaving the text selected.
    } finally {
      // Keeping it around would leave a stray focusable element on the page.
      setTimeout(() => scratch.remove(), 0);
    }
    return false;
  }
}
