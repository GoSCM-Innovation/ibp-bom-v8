/**
 * Derives the SAP IBP Fiori launchpad URL from an OData API URL.
 * e.g. https://my400439-api.scmibp.ondemand.com/sap/... → https://my400439.scmibp.ondemand.com
 */
export function getSapSystemUrl(apiUrl) {
  if (!apiUrl) return null
  try {
    const { protocol, hostname } = new URL(apiUrl)
    const systemHostname = hostname.replace(/-api\.scmibp(\d*)\./, '.scmibp$1.')
    if (systemHostname === hostname) return null // no transform matched
    return `${protocol}//${systemHostname}`
  } catch {
    return null
  }
}

/**
 * Derives the SAP IBP Fiori launchpad URL from a connection, using the URL of
 * any configured communication agreement (they all share the same tenant host).
 */
export function getConnectionSapUrl(conn) {
  if (!conn) return null
  const urls = [conn.com0326?.url, conn.com0068?.url, conn.com0924?.url, conn.com0720?.url]
  for (const url of urls) {
    const sapUrl = getSapSystemUrl(url)
    if (sapUrl) return sapUrl
  }
  return null
}
