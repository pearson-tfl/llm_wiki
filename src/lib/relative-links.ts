import type { ProjectPathIndex } from "@/lib/wiki-page-resolver"

const SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/

/**
 * A link written as a file path (`../x.md`, `x.md`, `/docs/x`): not a wiki
 * link (`#slug`), not protocol-relative (`//host/x`) and with no scheme.
 * Left to the webview, a click on one navigates the whole app window away.
 */
export function isRelativePathHref(href: string | null): href is string {
  return !!href && !href.startsWith("#") && !href.startsWith("//") && !SCHEME_RE.test(href)
}

/**
 * The project file a path link names, resolved against `fromDir`, the
 * folder of the page the link is written in (as Obsidian does), or null
 * when the project has no such file. Any `?query` or `#section` is dropped.
 */
export function resolveRelativeLink(href: string, fromDir: string, index: ProjectPathIndex): string | null {
  const url = new URL(href, `file://${fromDir.replace(/\/*$/, "/")}`)
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  const name = path.slice(path.lastIndexOf("/") + 1)
  return index.filesByName.get(name)?.find((entry) => entry.path === path)?.path ?? null
}
