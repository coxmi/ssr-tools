import { importUserModule } from '../utility/userEnv.ts'
import type { MatchedRoute } from './routes.ts'

type RouteErrorType = keyof typeof errors

export type PageProps = {
	path: string
	params: Readonly<Record<string, string | string[]>>
	query: URLSearchParams
}

export type ErrorPageProps = {
	status: number,
	error: string
}

const errors = {
	DEFAULT_EXPORT_NOT_CALLABLE: 'DEFAULT_EXPORT_NOT_CALLABLE',
	EMPTY_HANDLER: 'EMPTY_HANDLER',
	ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
	RESULT_PARSE_FAILED: 'RESULT_PARSE_FAILED',
	ERROR_ROUTE_NOT_FOUND: 'ERROR_ROUTE_NOT_FOUND',
} as const


export class RequestError extends Error {
	public httpCode: number
	public type: string
	constructor(httpCode: number, errorType: RouteErrorType, message: string, options: {} = {}) {
	    super(message, options)
		this.httpCode = httpCode
		this.type = errorType
	}
}

type HTMLTransform = (html: string) => string | Promise<string>

type RequestHandlerOptions = {
	url: string,
	matchedRoute: MatchedRoute
	importer?: (path: string) => Promise<unknown>
	htmlTransform?: HTMLTransform
	ctx: {
		req: any,
		res: any,
		next: () => unknown
	}
}

type GetPagePropsArgs = {
	url: string,
	routeParams: MatchedRoute['params']
	props: Record<string, any>
}

export function getPageProps({ url, routeParams, props = {} }: GetPagePropsArgs): PageProps {
	const [path, query] = url.split('?')
	return Object.freeze({
		path: path,
		params: routeParams ? Object.freeze({ ...routeParams }) : Object.freeze({}),
		query: new URLSearchParams(query),
		props
	})
}

export async function requestHandler(opts: RequestHandlerOptions): Promise<boolean> {
	
	const {
		url,
		matchedRoute,
		importer = ((x: string): Promise<unknown> => import(x)),
		htmlTransform = async html => html,
		ctx
	} = opts
	const props = getPageProps({ url, routeParams: matchedRoute.params, props: {} })
	const importPath = matchedRoute.route?.module
	const errorImportPath = matchedRoute.route?.error?.module

	try {
		// 404: no route matched
		if (!importPath) {
			let message = `No route matched "${props.path}"`
			throw new RequestError(404, errors.ROUTE_NOT_FOUND, message)
		}

		const imported = await importer(importPath)
		const handler = (imported as { default: unknown }).default

		// 500: not callable
		if (typeof handler !== 'function') {
			const message = `Default export for route "${importPath}" must be callable`
			throw new RequestError(500, errors.DEFAULT_EXPORT_NOT_CALLABLE, message)
		}

		const response = await handler(props)
		const parsed = await parseRouteResponse(response, importPath)
		if (parsed.headers['Content-Type'] === 'text/html') {
			ctx.res.setHeader('Content-Type', 'text/html')
			if (parsed.body) {
				const html = await htmlTransform(parsed.body)
				ctx.res.end(html)
			} else {
				ctx.res.end()
			}
		}

	} catch(err: unknown) {
		let errCode = 500
		let errMessage = "An unexpected error has occurred"

		if (err instanceof RequestError) {
			errCode = err.httpCode
			errMessage = err.message
		}
		logError(err)
		ctx.res.statusCode = errCode
		if (!errorImportPath) {
			ctx.res.end()
			return false
		}

		try {
			const errorImported = (await importer(errorImportPath))
			const errorHandler = (errorImported as { default: unknown }).default

			if (typeof errorHandler !== 'function') {
				ctx.res.statusCode = 500
				ctx.res.end()
				const errorRoute = matchedRoute.route?.error
				if (!errorRoute) throw new RequestError(500, errors.ERROR_ROUTE_NOT_FOUND, `Error route not found`)
				const message = `Default export for route "${errorRoute.module}" must be callable`
				throw new RequestError(500, errors.DEFAULT_EXPORT_NOT_CALLABLE, message)
			}
			const errorProps: ErrorPageProps = {
				status: errCode,
				error: errMessage
			}

			const response = await errorHandler(errorProps)
			const parsed = await parseRouteResponse(response, errorImportPath)
			if (parsed.headers['Content-Type'] === 'text/html') {
				ctx.res.setHeader('Content-Type', 'text/html')
				if (parsed.body) {
					ctx.res.end(await htmlTransform(parsed.body))
				} else {
					ctx.res.end()
				}
				return true
			}
			return false

		} catch(err) {
			if (err instanceof RequestError) {
				errCode = err.httpCode
				errMessage = err.message
			}
			logError(err)
			ctx.res.statusCode = errCode
			ctx.res.end()
			return false
		}
	}

	return false
}

const { default: renderToString } = await importUserModule('preact-render-to-string/jsx')

export type ParsedRouteResult = {
	headers: Record<string, string>
	end: Boolean
	body: string | undefined
	ext: string | undefined
}

export async function parseRouteResponse(input: any, name?: string) : Promise<ParsedRouteResult | never> {
	const result = await _parseRouteResponse(input, name)
	const mimeType = result.headers['Content-Type']
	const ext = mimeTypes[mimeType]
	return {
		...result, 
		ext 
	}
}

export async function _parseRouteResponse(input: any, name?: string): Promise<ParsedRouteResult | never> {

	const parsed: ParsedRouteResult = {
		headers: {},
		end: false,
		body: undefined,
		ext: undefined
	}
	
	// 404: nothing returned or user explicitly returned false, null, or undefined
	if (input === undefined || input === false || input === null) {
		const message = `Nothing returned from route handler ${name ? `"${name}"` : ''}`
		throw new RequestError(404, errors.EMPTY_HANDLER, message)
	}

	// any string is considered a text/html document by default
	// TODO: as long as the Content-Type header hasn't been edited
	if (typeof input === 'string') {
		parsed.headers['Content-Type'] = 'text/html'
		parsed.body = input
		parsed.end = true
		return parsed
	}

	// render preact DOM nodes
	// copy of isValidElement: https://github.com/preactjs/preact/blob/main/src/create-element.js#L100
	// TODO: investigate stronger type check
	if (input !== null && input.constructor === undefined) {
		let html = renderToString(input, {}, { pretty: true, jsx: false })
		parsed.headers['Content-Type'] = 'text/html'
		parsed.body = html
		parsed.end = true
		return parsed
	}

	if (input instanceof Response) {
		// TODO: parse Response object
	}

	throw new RequestError(
		500, errors.RESULT_PARSE_FAILED,
		`Handler return type "${typeof input}" not supported ${name ? `in "${name}"` : ''}`
	)
}


// TODO: better error messages, and requestHandler for behaviour when syntax / no defined / import error
const logError = (err: unknown) => {
	if (err instanceof RequestError) {
		console.log(`\n[Error: ${err.httpCode}]\n${err.message}\n`, err)
	} else if (err instanceof Error) {
		console.log(err)
	}
}

const mimeTypes: Record<string, string> = {
	'text/plain': '',
	'text/html': 'html',
	'text/javascript': 'js',
	'text/css': 'css',
	'text/csv': 'csv',
	'text/calendar': 'ics',
  	'application/json': 'json'
}