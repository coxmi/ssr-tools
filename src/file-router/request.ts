import { importUserModule } from '../utility/userEnv.ts'
import http from 'node:http'
import type { ErrorRoute, MatchedRoute } from './routes.ts'


type RouteErrorType = keyof typeof errors

export type PageProps = {
	params: Record<string, string | string[]>,
	path: string,
	query: URLSearchParams,
	request: { 
		[key: string]: any 
	} & http.IncomingMessage & { 
		originalUrl: string,
		path: string,
		query: string,
	},
	response: http.ServerResponse,
}

export type ErrorPageProps = {
	status: number,
	error: string
}

type RequestHandlerOptions = {
	importPath: string | undefined
	errorImportPath: string | undefined
	importer?: (path: string) => Promise<unknown>
	htmlTransform: (html: string) => string | Promise<string>
	matchedRoute: MatchedRoute
	req: any,
	res: any,
	next: () => unknown
}


const errors = {
	DEFAULT_EXPORT_NOT_CALLABLE: 'DEFAULT_EXPORT_NOT_CALLABLE',
	EMPTY_HANDLER: 'EMPTY_HANDLER',
	ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
	RESULT_PARSE_FAILED: 'RESULT_PARSE_FAILED'
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

const { default: renderToString } = await importUserModule('preact-render-to-string/jsx')


export async function requestHandler(ctx: RequestHandlerOptions): Promise<boolean> {

	const { importPath, errorImportPath, matchedRoute } = ctx
	const [path] = ctx.req.originalUrl.split('?') as string
	const importer = ctx.importer || ((x: string): unknown => import(x))

	try {
		// 404: no route matched
		if (!importPath || !matchedRoute.route) {
			let message = `Nothing found for "${ ctx.req.originalUrl || ctx.req.url }"`
			throw new RequestError(404, errors.ROUTE_NOT_FOUND, message)
		}

		const imported = await importer(importPath)
		const handler = (imported as { default: unknown | undefined }).default

		// 500: not callable
		if (typeof handler !== 'function') {
			const message = `Default export for route "${matchedRoute.route.module}" must be callable`
			throw new RequestError(500, errors.DEFAULT_EXPORT_NOT_CALLABLE, message)
		}

		const props: PageProps = Object.freeze({
			params: matchedRoute.params ? Object.freeze({ ...matchedRoute.params }) : {},
			path: path,
			query: ctx.req.query,
			request: ctx.req, 
			response: ctx.res,
		})
		return await parseRouteResult(ctx, await handler(props))

	} catch(err: unknown) {
		let errCode = 500
		let errMessage = "An unexpected error has occurred"

		if (err instanceof RequestError) {
			errCode = err.httpCode
			errMessage = err.message
		}
		logError(err)
		ctx.res.status(errCode)
		if (!errorImportPath) {
			ctx.res.end()
			return false
		}

		try {
			const errorImported = (await importer(errorImportPath))
			const errorHandler = (errorImported as { default: unknown | undefined }).default

			if (typeof errorHandler !== 'function') {
				ctx.res.status(500)
				ctx.res.end()
				const errorRoute = (matchedRoute.route?.error || matchedRoute.defaultError) as ErrorRoute
				const message = `Default export for route "${errorRoute.module}" must be callable`
				throw new RequestError(500, errors.DEFAULT_EXPORT_NOT_CALLABLE, message)
			}
			const errorProps: ErrorPageProps = {
				status: errCode,
				error: errMessage
			}

			await parseRouteResult(ctx, await errorHandler(errorProps))
			return false

		} catch(err) {
			if (err instanceof RequestError) {
				errCode = err.httpCode
				errMessage = err.message
			}
			logError(err)
			ctx.res.status(errCode)
			ctx.res.end()
			return false
		}
	}
}


async function parseRouteResult(ctx: RequestHandlerOptions, result: unknown): Promise<boolean | never> {
	
	// the user has sent the response directly, don't parse result
	if (ctx.res.writableEnded) return true

	// 404: nothing returned or user explicitly returned false, null, or undefined
	if (result === undefined || result === false || result === null) {
		const message = `Nothing returned from route handler "${ctx.matchedRoute.route?.module}"`
		throw new RequestError(404, errors.EMPTY_HANDLER, message)
	}

	// any string is considered a text/html document by default
	// TODO: as long as the Content-Type header hasn't been edited
	if (typeof result === 'string') {
		ctx.res.setHeader('Content-Type', 'text/html')
		ctx.res.end(await ctx.htmlTransform(result))
		return true
	}

	// render preact DOM nodes
	// copy of isValidElement: https://github.com/preactjs/preact/blob/main/src/create-element.js#L100
	// TODO: investigate stronger type check
	if (result !== null && result.constructor === undefined) {
		let html = renderToString(result, {}, { pretty: true, jsx: false })
		ctx.res.setHeader('Content-Type', 'text/html')
		ctx.res.end(await ctx.htmlTransform(html))
		return true
	}

	if (result instanceof Response) {
		// TODO: parse Response object
	}

	throw new RequestError(
		500, errors.RESULT_PARSE_FAILED,
		`Handler return type "${typeof result}" not supported in ${ctx.matchedRoute.route?.module}`
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