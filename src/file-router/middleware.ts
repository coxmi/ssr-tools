import { parse as parseUrl } from 'node:url'

export function removeTrailingSlash(req, res, next) {
	const url = parseUrl(req.originalUrl)
	if (url.pathname === '/') return next()
	if (url.pathname && url.pathname.slice(-1) === '/') {
		const query = url.search || ''
		const safepath = url.pathname.slice(0, -1).replace(/\/+/g, '/')
		res.statusCode = 301
		res.writeHead(301, { 'Location': safepath + query })
		res.end()
	} else {
		next()
	}
}