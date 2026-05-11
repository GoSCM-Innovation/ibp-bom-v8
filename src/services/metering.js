export function toODataDate(date) {
  return date.toISOString()
}

export function buildDateFilter(fromDate, toDate, field = 'Timestamp') {
  return `${field} ge ${toODataDate(fromDate)} and ${field} le ${toODataDate(toDate)}`
}

export function buildPath(entity, { filter, top = 500, orderby, select } = {}) {
  const parts = [`$top=${top}`]
  if (filter)  parts.push(`$filter=${encodeURIComponent(filter)}`)
  if (orderby) parts.push(`$orderby=${encodeURIComponent(orderby)}`)
  if (select)  parts.push(`$select=${select}`)
  return `/${entity}?${parts.join('&')}`
}

export function parseV4(json) {
  return json?.value ?? []
}
