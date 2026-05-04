export async function proxyCall({ connection, session, com = '0326', path, method = 'GET', body, injectJobUser }) {
  const agreement = com === '0068' ? connection.com0068 : connection.com0326
  const serviceRoot = agreement?.url || ''

  let fullPath = path || ''
  if (injectJobUser) {
    const jobUser = connection.jobUser || session?.user || agreement?.user || ''
    if (jobUser) fullPath += `&JobUser=%27${encodeURIComponent(jobUser)}%27`
  }

  return fetch('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: serviceRoot + fullPath,
      serviceRoot,
      user: session?.user || agreement?.user || '',
      password: session?.password || '',
      method,
      ...(body !== undefined && { body }),
    }),
  })
}
