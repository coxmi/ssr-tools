import type { Route } from './routes.ts'
import type { ParsedRouteResult } from './request.ts'
import { isBasic, isDynamic } from './routes.ts'
import { writeFile, mkdir } from 'node:fs/promises'
import { getPageProps, parseRouteResponse } from './request.ts'
import path from 'node:path'
import { styleText } from 'node:util'

type BuildStaticArgs = {
	htmlTransform?: (html: string) => string
}

type Logger = (message: string) => void

type ParamData = Record<string, string | string[] | undefined>


type Env = typeof env[keyof typeof env]

const env = {
	STATIC: Symbol('static'),
	DEV: Symbol('dev'),
	BUILD: Symbol('build')
} as const


function isDevEnv(current: Env) {
	return current === env.DEV
}

function isBuildEnv(current: Env) {
	return current === env.BUILD
}

function isStaticEnv(current: Env) {
	return current === env.STATIC
}


// TODO: refactor so errors within user modules
// can be caught and rethrown, to be dealt with in bundler's dev mode
// currently we eat any errors and only provide a summary message
class RouteProcessErrors {
	
	private errors: Record<string, Boolean> = {}
	private lastErrors: Record<string, Boolean> = {}
	private numErrors = 0
	
	add(message: string) {
		if (this.errors[message]) return this
		this.errors[message] = true
		this.numErrors++
		return this
	}

	last(message: string) {
		if (this.lastErrors[message]) return this
		this.lastErrors[message] = true
		this.numErrors++
		return this
	}

	warn(message: string, logger: Logger = console.log) {
		logger(message)
		return this
	}

	merge(...errs: RouteProcessErrors[]) {
		Object.assign(this.errors, ...(errs.map(err => err.errors)))
		Object.assign(this.lastErrors, ...(errs.map(err => err.lastErrors)))
		this.numErrors = Object.values(this.errors).length + Object.values(this.lastErrors).length
		return this
	}

	throw(): undefined | never {
		if (!this.numErrors) return
		const err = new Error('\n' + [	
			Object.keys(this.errors).join('\n'),
			Object.keys(this.lastErrors).join('\n'),
			`If you're facing a problem with ssr-tools not described above, please raise an issue at:\n` 
				+ `https://github.com/coxmi/ssr-tools/issues`
		].join('\n'))
		err.stack = ''
		throw err
	}

	get length() {
		return this.numErrors
	}
}


function validateExport(errors: RouteProcessErrors, route: Route, exported: unknown): RouteProcessErrors {
	if (!exported || !isObject(exported))
		return errors.add(`${route.name} – Export could not be parsed`)

	if (!('default' in exported))
		return errors.add(`${route.name} — No default export found, did you export the route function?`)

	if ('default' in exported && typeof exported.default !== 'function')
		errors.add(`${route.name} — Must export a function, exported '${typeof exported.default}'`)

	return errors
}


function validateExportBuildArgs(errors: RouteProcessErrors, route: Route, exported: any, env: Env): RouteProcessErrors {

	const { build } = exported

	// static routes can be built without any exported build args
	if (isBasic(route) && !build) return errors

	// dynamic routes require build exports when building statically
	if (isStaticEnv(env) && isDynamic(route) && !build) {
		return errors.add(
			`${route.name} – dynamic routes must export static build options, e.g:\n\n` 
			+ `export const build = {\n  from: () => [...props],\n  url: () => '/path'\n}`
		)
	}

	// build.from and build.url only need to exist for dynamic routes
	if (isDynamic(route)) {
		const requiredFns = ['from', 'url']
		const missingFns = requiredFns.filter(ref => {
			if (ref === 'from' && isIterable(build[ref])) return false
			return typeof build[ref] !== 'function'
		})
		if (missingFns.length) {
			const fns = missingFns.map(fn => `'build.${fn}'`).join(' and ')
			const s = missingFns.length === 1 ? '' : 's'
			const type = isDynamic(route) ? 'dynamic' : 'static'
			errors.add(`${route.name} – ${fns} export required in ${type} routes`)
		}		
	}

	// on static routes: if build.url has been defined warn that it won't be used
	if (isBasic(route) && build && (build.from || build.url)) {
		const fns = ['url']
		const used = fns.filter(fn => typeof build[fn] === 'function').map(fn => `build.${fn}`).join(' and ')
		const willNotBe = isDevEnv(env) ? 'will not be' : (used.length ? 'were not' : 'was not')
		errors.warn(
			`${route.name} – ${used} ${willNotBe} used when building static pages. `
			+ `Use a dynamic file name to generate multiple pages.`
		)
	}

	return errors
}


function parseUserUrlResult(route: Route, result: unknown): { path: string, params: ParamData } | never {

	const asString = toString(result)

	// if it's a string, check it against the route filename pattern
	if (typeof result === 'string') {
		const userUrl = result
		const match = route.match(userUrl)
		if (!match) {
			throw new Error(
				`${route.name} – Returned url "${asString}" does not match filename pattern "${route.routepath}"`
			)
		}
		const path = match.path
		const params = match?.params || {}
		return { path, params }
	}

	// can also return a params object, check for basic object props
	if (!isObject(result)) {
		throw new Error(
			`${route.name} – Value returned from build.url is not an object or a url string` + 
			`${asString && `: ${asString}` || ''}`
		)
	}

	const requiredParams = Object.keys(route.requiredParams)
	if (!isRecordWithKeys(result, requiredParams)) {
		throw new Error(
			`${route.name} – Params missing from build.url: [${requiredParams.join(', ')}]`
		)
	}
	
	const matches = route.matchParams(result)
	if (matches) return matches
	
	throw new Error(
		`${route.name} – Could not parse result of build.url${asString && `: ${asString}` || ''}`
	)		
}

/**
	Processes exported route. Usage:

	```ts
	const proc = new RouteProcess(route: Route, exported: any)
	proc.buildStatic(outputDir)
	```

	Exported route must be in the form:

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

class RouteProcess {

	route: Route
	exported: any
	output: Array<[string, ParsedRouteResult]> = []
	errors = new RouteProcessErrors()

	constructor(route: Route, exported: any) {
		this.route = route
		this.exported = exported
	}

	async buildStatic(args: BuildStaticArgs = {}): Promise<RouteProcessErrors> {
		
		// do route validation up front, and merge errors
		// we want all of the parse errors at the same time, 
		// so we don't throw, that's done in the batch process
		validateExport(this.errors, this.route, this.exported)
		validateExportBuildArgs(this.errors, this.route, this.exported, env.STATIC)
		if (this.errors.length) return this.errors

		if (isBasic(this.route)) {
			// routes without a dynamic url only render a single url with no params
			// so we skip the props/routeParams steps
			const url = this.route.routepath
			const routeParams = {}
			const renderProps = {}
			const props = getPageProps({ 
				url, 
				routeParams, 
				props: renderProps 
			})
			try {
				const output = await this.exported.default(props)
				const parsed = await parseRouteResponse(output, this.route.name)
				this.output.push([ url, parsed ])
			} catch(e) {
				if (e instanceof Error) 
					this.errors.add(`${this.route.name} – ${ e.message || 'Server error in route function'}`)
				return this.errors
			}

		} else if (isDynamic(this.route)) {

			const { build } = this.exported
			const getUrl = toFunc(build.url)
			const getFrom = toFunc(build.from)

			let userBuildFrom: Array<unknown>
			let userBuildUrl: { path:string, params: ParamData }[]
			try {
				userBuildFrom = await getFrom()
				if (!isIterable(userBuildFrom)) {
					this.errors.add(`${this.route.name} — Value returned from build.from is not an interable`)
					return this.errors
				}
				userBuildFrom = Array.from(userBuildFrom)
				userBuildUrl = await Promise.all(
					userBuildFrom.map(async (entry: any) => {
						const urlObj: unknown = await getUrl(entry)
						return parseUserUrlResult(this.route, urlObj)
					})
				)
			} catch(e) {
				if (e instanceof Error) 
					this.errors.add(`${this.route.name} – ${e.message || 'Server error in user build.from or build.url functions'}`)
				return this.errors
			}

			await Promise.all(userBuildUrl.map(async (urlProps, index) => {
				const { path, params } = urlProps
				const props = getPageProps({ 
					url: path, 
					routeParams: params,
					props: (userBuildFrom[index] || {})
				})
				try {
					const url = path
					const output = await this.exported.default(props)
					const parsed = await parseRouteResponse(output, this.route.name)
					this.output.push([ url, parsed ])
				} catch(e) {
					if (e instanceof Error) 
						this.errors.add(`${this.route.name} – ${e.message || 'Server error in route function'}`)
				}
			}))
		}

		if (typeof args.htmlTransform === 'function') {
			for (const output of this.output) {
				const [_, parsed] = output
				if (parsed.headers['Content-Type'] === 'text/html') {
					if (parsed.body) parsed.body = args.htmlTransform(parsed.body)
				}
			}
		}

		return this.errors
	}
}


export class RouteBatchProcess {
	routes: RouteProcess[] = []
	errors: RouteProcessErrors = new RouteProcessErrors()
	processed: Record<string, string> = {}
	logger: Logger

	constructor(logger: Logger = console.log) {
		this.logger = logger
	}
	
	add(route: Route, exported: any) {
		const proc = new RouteProcess(route, exported)
		this.routes.push(proc)
	}

	async buildStatic(args: BuildStaticArgs = {}) {
		const errors = await Promise.all(this.routes.map(proc => proc.buildStatic(args)))
		this.errors.merge(...errors)

		this.routes.map(proc => {
			for (const out of proc.output) {
				const [url, parsed] = out
				if (typeof parsed.body === 'undefined') continue
				const filename = outputFileName(url, parsed.ext)
				const exists = this.processed[filename]	
				if (exists) {
					this.errors.add(`"${filename}" already exists, skipping duplicate`)
					continue
				}
				this.processed[filename] = parsed.body
			}
		})

		if (this.errors.length) this.errors.throw()
	}

	async write(outputDir: string, buildDir: string) {
		const entries = Object.entries(this.processed)
		const number = entries.length
		await Promise.all(
			entries.map(async ([file, body]) => {
				const outputPath = path.join(outputDir, file)
				await emitFile(outputPath, body)
			})
		)

		this.logger(`${styleText('green', '✓')} Created ${number} static file${number === 1 ? '' : 's'}.`)	
		
		const buildDirName = styleText('dim', path.basename(buildDir) + '/')
		const outputDirName = path.relative(buildDir, outputDir)
		const limit = entries
			.map(x => {
				const filePath = styleText('magentaBright', path.join(outputDirName, x[0]))
				return buildDirName + filePath
			})
			.sort()
			.slice(0, 15)
		if (limit.length < entries.length) {
			const diff = entries.length - limit.length
			const s = diff === 1 ? '' : 's'
			limit.push(styleText('dim', `...And ${diff} other pages${s}`))
		}
		
		const message = limit.join('\n')
		this.logger(message)
	}
}


function outputFileName(path: string, type:string = '') {
	let base = path
	if (path.endsWith('/')) base += 'index'
	if (type) base+= `.${type}`
	return base
}


async function emitFile(outputPath: string, contents: string) {
	await mkdir(path.dirname(outputPath), { recursive: true })
	await writeFile(outputPath, contents, { flag: 'w+' })
}


function isRecordWithKeys(value: object, keys: string[]): value is Record<PropertyKey, string | string[]> {
	if (typeof value !== "object" || value === null) return false
	const record = value as Record<PropertyKey, unknown>
	return keys.every(key =>
		key in record && (
			typeof record[key] === "string" || (
				Array.isArray(record[key]) 
				&& record[key].every(v => typeof v === "string")
        )
       )
	)
}


function isIterable(x: unknown) {
	return Symbol.iterator in Object(x)
}


function isObject(obj: unknown): obj is object {
  return obj === Object(obj)
}


function toString(obj: unknown) {
	let string = typeof obj?.toString === 'function' ? obj.toString() : ''
	if (string.startsWith('[object')) {
		try { string = JSON.stringify(obj, null, 2) } catch(e) {}
	}
	return string
}


// TODO: change any type to unknown, and fix parse type errors in RouteProcess.buildStatic
function toFunc(obj: any): (...args: any[]) => any  {
	if (typeof obj === 'function') return obj
	return () => obj
}