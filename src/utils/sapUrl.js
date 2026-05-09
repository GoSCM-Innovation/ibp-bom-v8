/**
 * Derives the SAP IBP Fiori launchpad URL from an OData API URL.
 * e.g. https://my400439-api.scmibp.ondemand.com/sap/... → https://my400439.scmibp.ondemand.com
 */
export function getSapSystemUrl(apiUrl) {
  if (!apiUrl) return null
  try {
    const { protocol, hostname } = new URL(apiUrl)
    const systemHostname = hostname.replace(/-api\.scmibp\./, '.scmibp.')
    if (systemHostname === hostname) return null // no transform matched
    return `${protocol}//${systemHostname}`
  } catch {
    return null
  }
}
