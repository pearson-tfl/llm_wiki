import { openUrl } from "@tauri-apps/plugin-opener"

// Tauri's webview has no back button: a plain click on a web link would
// navigate the whole app window away with no way back. Every such link
// goes to the system browser instead.
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"])

/**
 * The URL to open in the system browser for a link's written href, or
 * null when the app should handle the click: wiki links (`#slug`),
 * in-page anchors and relative paths are not absolute URLs.
 */
export function externalUrl(href: string | null): string | null {
  if (!href) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null
}

/**
 * Document-level click listener. A click a component already handled
 * (it called preventDefault) is left alone so the link opens once.
 */
export function handleExternalLinkClick(event: MouseEvent, open: (url: string) => Promise<void> = openUrl): void {
  if (event.defaultPrevented) return
  const anchor = (event.target as Element | null)?.closest?.("a[href]")
  const url = externalUrl(anchor?.getAttribute("href") ?? null)
  if (!url) return
  event.preventDefault()
  void open(url).catch((err) => {
    console.warn("[external-links] openUrl failed:", err)
  })
}
