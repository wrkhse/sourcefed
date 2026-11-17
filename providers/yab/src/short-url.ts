export function shortUrl(href: string): string {
  const url = new URL(href)
  return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`
}
