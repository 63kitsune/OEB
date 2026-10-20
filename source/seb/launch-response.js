// Recognize SEB responses without depending on the browser's chosen filename.
export function isSebConfigurationUrl(value = "") {
  if (/^(?:sebs?):\/\//i.test(value) || /(?:^|[/?=&])[^/?=&]*\.seb(?:$|[?#&])/i.test(value)) return true;
  try {
    return /\/mod\/quiz\/accessrule\/seb\/config\.php$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

export function classifySebResponse(details) {
  const headers = Object.fromEntries((details.responseHeaders || []).map(h => [h.name.toLowerCase(), h.value || ""]));
  const disposition = headers["content-disposition"] || "";
  const mime = (headers["content-type"] || "").split(";", 1)[0].trim();
  const recognized = details.knownSebRequest === true || isSebConfigurationUrl(details.url)
    || /filename\*?\s*=.*\.seb(?:["';]|$)/i.test(disposition)
    || /^(?:application\/(?:x-)?seb|application\/safe-exam-browser)$/i.test(mime);
  // Never cancel background fetches or redirect responses. The original URL may
  // redirect to a signed/extensionless configuration URL.
  const navigation = ["main_frame", "sub_frame"].includes(details.type);
  const success = details.statusCode >= 200 && details.statusCode < 300;
  return { recognized, consume: recognized && navigation && success && details.tabId >= 0, disposition };
}
