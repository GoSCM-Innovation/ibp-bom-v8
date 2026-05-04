export async function proxyCall({ connection, session, com = '0326', path, method = 'GET', body, injectJobUser }) {
  const comKey = `com${com}`
  const agreement = connection[comKey]
  const serviceRoot = agreement?.url || ''
  const sessionCreds = session?.[comKey] || {}

  let fullPath = path || ''
  if (injectJobUser) {
    const jobUser = connection.jobUser || sessionCreds.user || agreement?.user || ''
    if (jobUser) fullPath += `&JobUser=%27${encodeURIComponent(jobUser)}%27`
  }

  return fetch('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: serviceRoot + fullPath,
      serviceRoot,
      user: sessionCreds.user || agreement?.user || '',
      password: sessionCreds.password || '',
      method,
      ...(body !== undefined && { body }),
    }),
  })
}
