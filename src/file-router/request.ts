import { createRequest, sendResponse } from '@remix-run/node-fetch-server'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2'

export type NodeRequest = IncomingMessage | Http2ServerRequest
export type NodeResponse = ServerResponse | Http2ServerResponse
export type Next = (...args: any[]) => any


export function staticRequestFromPath(path: string) {
	return new Request(new URL('http://localhost' + path), {
		method: 'GET'
	})
}


export function webRequestFromNode(req: NodeRequest, res: NodeResponse): Request {
	// @ts-expect-error: replace url with vite's req.originalUrl
	req.url = req.originalUrl
	const request = createRequest(req, res)
	return request
}


export function sendNodeResponse(response: Response, res: NodeResponse) {
	sendResponse(res, response)
}

const mimeTypes = {
	'text/plain': '',
	'text/html': 'html',
	'text/javascript': 'js',
	'text/css': 'css',
	'text/csv': 'csv',
	'text/calendar': 'ics',
  	'application/json': 'json'
} as const

type Extension = typeof mimeTypes[keyof typeof mimeTypes]

export function extension(response: Response): Extension {
	const mimeType = (response.headers.get('Content-Type') || '') as keyof typeof mimeTypes
	if (!mimeType || !(mimeType in mimeTypes)) return mimeTypes['text/plain']
	return mimeTypes[mimeType]
}

export function isTextFormat(response: Response): boolean {
	const mime = response.headers.get('Content-Type') || ''
	return mime in mimeTypes
}