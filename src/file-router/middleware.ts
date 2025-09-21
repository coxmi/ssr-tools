import { parse as parseUrl } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

export function removeTrailingSlash(req: IncomingMessage, res: ServerResponse, next: () => any) {
	if (!req.url) return next()
	const url = new URL(req.url, `http://${req.headers.host}/`)
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