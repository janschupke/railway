/**
 * Getting text out of the page and into the reader's hands.
 *
 * Two ways out — the clipboard and a file — and nothing else belongs here. The test is
 * whether a function is about *leaving*: it takes a string the caller already has and
 * puts it somewhere the browser owns. Anything that formats, filters or decides what the
 * string should say belongs with the thing that knows, which is why `serializeLines` and
 * `logFileName` stay in lib/log-view.ts.
 *
 * A topic-named module rather than a generic `dom.ts`, following `lib/format.ts`, which
 * was split out of a `utils.ts` that had become three unrelated concerns. This is the
 * first module in `src/lib/` that touches the DOM; `random-id.ts` is the closest sibling
 * and documents its own browser/server duality the same way. Both functions below are
 * browser-only and neither is safe to call during a render.
 *
 * They were inline in log-pane.tsx, a 543-line presentation component, where neither had
 * anything to do with logs — the same argument format.ts's own header makes.
 */

/**
 * The clipboard, or an honest failure.
 *
 * `navigator.clipboard` is undefined on an insecure origin, so the property access itself
 * throws and the catch covers it — no separate feature test is needed. It also rejects on
 * a denied permission and when the document is not focused, and all three are the same
 * thing to the caller: the text did not go anywhere, and the user needs to be told rather
 * than left believing it did.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Hands the browser a file to save, named by the caller. */
export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next task rather than inline: a synchronous revoke can abort the
  // download the click has only just started, and it fails silently — no error, no file.
  setTimeout(() => URL.revokeObjectURL(url));
}
