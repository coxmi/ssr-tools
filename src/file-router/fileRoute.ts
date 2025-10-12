import { isBasic, isDynamic } from './routes.ts'
import { isRecord, isRecordWithKeys, isIterable, isObject } from '../utility/types.ts'
import type { Route, RouteRequestData, ParamData } from './routes.ts'
import { importUserModule } from '../utility/userEnv.ts'

type Env = typeof env[keyof typeof env]

export const env = Object.freeze({
	STATIC: Symbol('static'),
	DEV: Symbol('dev'),
	BUILD: Symbol('build')
})


function isDevEnv(current: Env) {
	return current === env.DEV
}

function isBuildEnv(current: Env) {
	return current === env.BUILD
}

function isStaticEnv(current: Env) {
	return current === env.STATIC
}

type PageProps = {
	request: Request
	url: URL
	params: Readonly<Record<string, string | string[]>>
	props: unknown
}

type ErrorPageProps = PageProps & {
	error: Error
}

type GetPagePropsArgs = {
	req: Request,
	routeParams: ParamData
	props: unknown
}

export function getPageProps({ req, routeParams, props = {} }: GetPagePropsArgs): PageProps {
	const url = new URL(req.url)
	return Object.freeze({
		request: req,
		url: url,
		params: routeParams ? Object.freeze({ ...routeParams }) : Object.freeze({}),
		props
	})
}

export type Importer = (path: string) => Promise<unknown>

export type HTMLTransform = (html: string) => Promise<string>

export type UserHTMLTransform = (
	html: string, 
	options: { 
		request: Request, 
		isErrorRequest: boolean 
	}
) => Promise<string>

export type FileRoute = {
	handler: (context: PageProps, htmlTransform: UserHTMLTransform) => Promise<Response>
	errorHandler: (context: ErrorPageProps, htmlTransform: UserHTMLTransform) => Promise<Response>
	buildFrom: () => Promise<Iterable<unknown>>
	buildUrl: (props: unknown) => Promise<RouteRequestData>
}

function createHtmlTransformer(
		userHtmlTransform: UserHTMLTransform, 
		context: PageProps, 
		isErrorRequest: boolean
	): HTMLTransform {
		return html => userHtmlTransform(html, { 
			request: context.request,
			isErrorRequest
		})
	}

/**
	Parses route export in to a FileRoute object.
	Module exports should be in the following form:

	```ts
	export const build = {
		from: async () => [
			{ title: 'My page', slug: 'my-page' }, 
			{ title: 'Another page', slug: 'another-page' }
		],
		url: props => `/${props.slug}`
	}

	// TODO: add handlers for GET/POST/HEAD/etc
	export const handlers = {
		GET: ctx => new Response(),
		POST: ctx => new Response(),
	}

	export default function page({ req, res, props, params, url, route, ...ctx }) {
		return `<html>
			<body>
				<h1>${props.title}</h1>
				<pre>${JSON.stringify(params)}</pre>
			</body>
		</html>`
	}
	``` 
 */
export async function createFileRoute(route: Route, importer: Importer, env: Env): Promise<FileRoute> {

	const importPath = route.module
	const errorImportPath = route.error?.module
	
	const mod = await importer(importPath)
	const exported = parseModule(route, mod)
	const build = parseModuleBuild(route, exported, env)

	async function handler(context: PageProps, htmlTransform: UserHTMLTransform) {
		const renderHandler = toFnAsync(unknownProp(exported, 'default'))
		return await responseHandler(
			await renderHandler(context), 
			createHtmlTransformer(htmlTransform, context, false)
		)
	}

	const errorHandler = async (context: ErrorPageProps, htmlTransform: UserHTMLTransform) => {
		const res = new Response(null, { status: 500 })
		if (!errorImportPath) return res
		const errorExported = await importer(errorImportPath)
		const errorHandler = toFnAsync(unknownProp(errorExported, 'default'))
		return await responseHandler(
			await errorHandler(context), 
			createHtmlTransformer(htmlTransform, context, true)
		)
	}

	// parse build options for static routes
	const buildFrom = async () => parseResultBuildFrom(route, await build.from())
	const buildUrl = async (props: unknown) => parseResultBuildUrl(route, await build.url(props))

	return {
		handler,
		errorHandler,
		buildFrom,
		buildUrl,
	}
}


type ParseModuleResult = {
	default: unknown
}

type ParseModuleBuildResult = {
	from: (() => Promise<unknown>)
	url: ((props: unknown) => Promise<unknown>)
}

// TODO use more specific error, e.g. SyntaxError for parsing modules
// Stacks show code in ssr-tools rather than user code when errors occur

// declare const SyntaxError: SyntaxErrorConstructorWithLocation
// interface SyntaxErrorConstructorWithLocation {
//   new (message?: string, fileName?: string, lineNumber?: number): SyntaxError
//   (message?: string, fileName?: string, lineNumber?: number): SyntaxError
//   readonly prototype: SyntaxError
// }

function parseModule(route: Route, exported: unknown): ParseModuleResult | never  {
	if (!exported || !isObject(exported)) {
		throw new Error(`Export could not be parsed`)
	}
	if (!('default' in exported)) {
		throw new Error(`${route.name} — No default export found, did you export the route function?`)
	}
	if ('default' in exported && exported && typeof exported.default !== 'function') {
		throw new Error(`${route.name} — Must export a function, exported '${typeof exported.default}'`)
	}
	return exported
}

function parseModuleBuild(route: Route, exported: ParseModuleResult, env: Env): ParseModuleBuildResult | never {

	// default return types are unknown for now
	// we have to deal with these at build time
	const parsed: ParseModuleBuildResult = {
		from: async () => [],
		url: async () => ({}),
	}

	const hasBuild = 'build' in exported

	// dynamic routes require build exports when building statically
	if (!hasBuild && isStaticEnv(env) && isDynamic(route)) {
		throw new Error(
			`dynamic routes must export static build options, e.g:\n\n` 
			+ `export const build = {\n  from: () => [...props],\n  url: () => ({slug:'hello-world'})\n}`
		)
	}

	// basic routes don't need build, so return parsed if there's nothing set
	if (!hasBuild || !isRecord(exported.build)) return parsed
	const { build } = exported

	// static: build.from and build.url only need to exist for dynamic routes
	if (isStaticEnv(env) && isDynamic(route)) {
		const requiredFns = ['from', 'url']
		const missingFns = requiredFns.filter(ref => {
			if (ref === 'from' && isIterable(build[ref])) return false
			return typeof build[ref] !== 'function'
		})
		if (missingFns.length) {
			const fns = missingFns.map(fn => `'build.${fn}'`).join(' and ')
			const type = isDynamic(route) ? 'dynamic' : 'static'
			throw new Error(
				`${fns} export required in ${type} routes`
			)
		}
		parsed.from = toFnAsync(build.from)
		parsed.url = toFnAsync(build.url)
	}

	// on basic routes, if build.url has been defined warn that it wasn't/won't be used
	if (isBasic(route) && build && (build.from || build.url)) {
		const fns = ['url']
		const used = fns.filter(fn => typeof build[fn] === 'function').map(fn => `build.${fn}`).join(' and ')
		const willNotBe = isDevEnv(env) ? 'will not be' : (used.length ? 'were not' : 'was not')
		console.warn(
			`${used} ${willNotBe} used when building static pages. `
			+ `Use a dynamic file name to generate multiple pages.`
		)
	}

	return parsed
}

function parseResultBuildFrom(route: Route, result: unknown): Iterable<unknown> | never {
	if (isIterable(result)) return result
	throw new Error(`Value returned from build.from is not an interable`)
}

function parseResultBuildUrl(route: Route, result: unknown): RouteRequestData | never {

	const asString = toString(result)

	// if it's a string, check it against the route filename pattern
	if (typeof result === 'string') {
		const userUrl = result
		const match = route.match(userUrl)
		if (!match) {
			throw new Error(
				`Returned url "${asString}" does not match filename pattern "${route.routepath}"`
			)
		}
		const path = match.path
		const params = match?.params || {}
		return { path, params }
	}

	// can also return a params object, check for basic object props
	if (!isObject(result)) {
		throw new Error(
			`Value returned from build.url is not a params object or url string` + 
			`${asString && `: ${asString}` || ''}`
		)
	}

	const requiredParams = Object.keys(route.requiredParams)
	if (!isRecordWithKeys(result, requiredParams)) {
		throw new Error(
			`Params missing from build.url: [${requiredParams.join(', ')}]`
		)
	}
	
	const requestData = route.requestDataFromParams(result)
	if (requestData) return requestData
	
	throw new Error(
		`Could not parse result of build.url${asString && `: ${asString}` || ''}`
	)		
}

export async function responseHandler(
	input: unknown, 
	htmlTransform: HTMLTransform = async x => x,
): Promise<Response> | never {

	// 404: nothing returned or user explicitly returned false, null, or undefined
	if (input === undefined || input === false || input === null) {
		return new Response(null, { status: 404 })
	}

	// accept a web Response object
	if (input instanceof Response) {
		if (input.headers.get('Content-Type') === 'text/html') {
			return copyResponse(input, {
				body: await htmlTransform(await input.text())
			})
		}
		return input
	}

	// any string is considered a text/html document by default
	if (typeof input === 'string') {
		return new Response(await htmlTransform(input), {
			headers: { 'Content-Type': 'text/html' }
		})
	}

	// render preact DOM nodes
	// element check copy of isValidElement: 
	// https://github.com/preactjs/preact/blob/main/src/create-element.js#L86
	// TODO: investigate stronger type check
	// e.g. ('_depth' in element) && ('_original' in element) && ('_flags' in element)
	if (input !== null && input.constructor === undefined) {
		const { default: renderToString } = await importUserModule('preact-render-to-string')
		let html = renderToString(input)
		html = await htmlTransform(html) 
		return new Response(html, {
			headers: { 'Content-Type': 'text/html' }
		})
	}

	// TODO: plan how to include multiple frameworks
	// identify main frameworks from bundler config, or add providers in config options

	// everything else is currently unsupported
	throw new Error(
		`Handler return type "${typeof input}" not supported`
	)
}

interface CopyResponseOptions extends ResponseInit {
	body?: BodyInit
}

function copyResponse(original: Response, options: CopyResponseOptions = {}) {
	return new Response(options.body || original.clone().body, {
      status: options.status || original.status,
      statusText: options.statusText || original.statusText,
      headers: mergeHeaders(
      	original.headers, 
      	options.headers || {}
      ),
    })
}

function mergeHeaders(...sources: HeadersInit[]): Headers {
  const merged = new Headers()
  for (const source of sources) {
    if (!source) continue
    // convert anything that fits HeadersInit int a Headers object
    const input = new Headers(source)
	// @ts-ignore: headers.entries() exists
	// https://developer.mozilla.org/en-US/docs/Web/API/Headers/entries
    for (const [key, value] of input.entries()) {
      merged.set(key, value)
    }
  }
  return merged
}


function toString(obj: unknown) {
	let string = typeof obj?.toString === 'function' ? obj.toString() : ''
	if (string.startsWith('[object')) {
		try { string = JSON.stringify(obj, null, 2) } catch(e) {}
	}
	return string
}

function toFnAsync<T>(input: T | ((...args: any[]) => T)): (...args: any[]) => Promise<T> {
    if (typeof input === "function") {
        return (...args: any[]) => Promise.resolve((input as (...args: any[]) => T)(...args))
    } else {
        return async () => input
    }
}

function unknownProp(obj: unknown, key: string): unknown | undefined {
	if (isRecord(obj) && key in obj) return obj[key]
	return undefined
}