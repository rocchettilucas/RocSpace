const SEARCH_URL = "https://www.google.com/search";

export function normalizeBrowserAddress(input: string): string {
  const address = input.trim();

  if (isHttpUrl(address)) {
    return new URL(address).toString();
  }

  if (address.startsWith("//")) {
    return new URL(`https:${address}`).toString();
  }

  if (looksLikeLocalHost(address)) {
    return new URL(`http://${address}`).toString();
  }

  if (looksLikeDomain(address)) {
    return new URL(`https://${address}`).toString();
  }

  const searchUrl = new URL(SEARCH_URL);
  searchUrl.searchParams.set("q", address);
  return searchUrl.toString();
}

function isHttpUrl(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeLocalHost(address: string): boolean {
  return /^(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i.test(
    address,
  );
}

function looksLikeDomain(address: string): boolean {
  if (/\s/.test(address)) return false;
  return /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(address);
}
