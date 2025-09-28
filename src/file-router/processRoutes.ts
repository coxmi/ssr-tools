import type { Route } from './routes.ts'
import type { ParsedRouteResult } from './request.ts'
import { isStatic, isDynamic } from './routes.ts'
import { writeFile, mkdir } from 'node:fs/promises'
import { getPageProps, parseRouteResponse } from './request.ts'
import path from 'node:path'
import { styleText } from 'node:util'
import util from 'node:util'

type BuildStaticArgs = {
	htmlTransform?: (html: string) => string
}

type Logger = (message: string) => void

type ParamData = Record<string, string | string[] | undefined>

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
		
		// basic route validation
		this.validateExport(this.route, this.exported)

		// we want all of the parse errors at the same time, so don't throw just yet
		// we'll do that in the batch process
		if (this.errors.length) return this.errors

		// default error
		const logErr = (e: unknown, defaultMessage: string = '') => {
			if (e instanceof Error) {
				this.errors.add(`${this.route.name} — ${e.message || defaultMessage || 'Server error'}`)
			} else {
				this.errors.add(`${this.route.name} — ${defaultMessage || 'Server error'}`)
			}
		}

		if (isStatic(this.route)) {
			const isValid = (
				this.validateExportBuildStatic(this.route, this.exported) 
				&& this.validateExportBuildDynamic(this.route, this.exported)
			)

			if (!isValid) return this.errors
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
				logErr(e, 'server error in route function')
				return this.errors
			}

		} else if (isDynamic(this.route)) {
			const valid = this.validateExportBuildDynamic(this.route, this.exported)
			if (!valid) return this.errors

			// find build export if it exists
			const { build } = this.exported
			// no build arguments for route with dynamic filename, so we don't render it
			if (!build) return this.errors

			const getUrl: (...args: any[]) => any = typeof build.url === 'function'
				? build.url 
				: (props: any) => props

			let userBuildFrom: Array<unknown>
			let userBuildUrl: { path:string, params: ParamData }[]
			try {
				userBuildFrom = [...(await build.from())]
				if (!isIterable(userBuildFrom)) {
					this.errors.add(`${this.route.name} — Value returned from build.from is not an interable`)
					return this.errors
				}

				userBuildUrl = await Promise.all(
					[...userBuildFrom].map(async (entry: any) => {
						const urlObj: unknown = await getUrl(entry)
						return this.parseUserUrlResult(this.route, urlObj)
					})
				)
			} catch(e) {
				logErr(e, 'server error in user build.from or build.url functions')
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
					logErr(e, 'server error in route function')
					return this.errors
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

	validateExport(route: Route, exported: any): void {
		if (!exported.default)
			this.errors.add(`${route.name} — No default export found, did you export the route function?`)

		if (exported.default && typeof exported.default !== 'function') {
			this.errors.add(`${route.name} — Must export a function, exported '${typeof exported.default}'`)
		}
	}

	validateExportBuildDynamic(route: Route, exported: any): boolean {
		// no build arguments, so this doesn't need to be parsed
		const { build } = exported
		if (!build) return true

		const requiredFns = [
			'from', 
			// url is not required, if the params can be found in the props
			// 'url'
		]

		const missingFns = requiredFns.filter(ref => typeof build[ref] !== 'function')
		if (missingFns.length) {
			const fns = missingFns.map(fn => `'${fn}'`).join(' and ')
			const s = missingFns.length === 1 ? '' : 's'
			this.errors.add(`${route.name} – ${fns} function export${s} required in dynamic route`)
			return false
		}

		return true
	}

	validateExportBuildStatic(route: Route, exported: any): boolean {
		const { build } = exported
		if (build && (build.from || build.url)) {
			const fns = [
				'from', 
				// url is not required, if the params can be found in the props
				// 'url'
			]
			const used = fns.filter(fn => typeof build[fn] === 'function').map(fn => `build.${fn}`).join(' and ')
			const were = used.length ? 'were' : 'was'
			this.errors.warn(
				`${route.name} – ${used} ${were} not used when building static pages. `
				+ `Use a dynamic file name to generate multiple pages.`
			)
		}

		return true
	}

	parseUserUrlResult(route: Route, result: unknown): { path: string, params: ParamData } | never {

		const asString = toString(result)

		if (typeof result === 'string') {
			// if it's a string, check it against the route filename pattern
			const userUrl = result
			const match = route.match(userUrl)
			if (match) {
				const path = match.path
				const params = match?.params || {}
				return { path, params }
			} else {
				throw new Error(
					`returned url "${asString}" does not match filename pattern "${route.routepath}"`
				)
			}
		}

		if (!isObject(result)) {
			throw new Error(
				`value returned from build.url is not an object or a url string` + 
				`${asString && `: ${asString}` || ''}`
			)
		}

		const requiredParams = Object.keys(route.requiredParams)
		if (!isRecordWithKeys(result, requiredParams)) {
			throw new Error(
				`params missing from build.url: [${requiredParams.join(', ')}]`
			)
		}
		
		const matches = route.matchParams(result)
		if (matches) return matches
		
		throw new Error(
			`Could not parse result of build.url${asString && `: ${asString}` || ''}`
		)		
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

class RouteProcessErrors {
	// dedupes errors using object keys
	private errors: Record<string, Boolean> = {}
	private lastErrors: Record<string, Boolean> = {}
	private numErrors = 0
	
	add(message: string) {
		if (this.errors[message]) return
		this.errors[message] = true
		this.numErrors++
	}

	last(message: string) {
		if (this.lastErrors[message]) return
		this.lastErrors[message] = true
		this.numErrors++
	}

	warn(message: string, logger: Logger = console.log) {
		logger(message)
	}

	merge(...errs: RouteProcessErrors[]) {
		Object.assign(this.errors, ...(errs.map(err => err.errors)))
		Object.assign(this.lastErrors, ...(errs.map(err => err.lastErrors)))
		this.numErrors = Object.values(this.errors).length + Object.values(this.lastErrors).length
	}

	throw() {
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

// function parseParamsRecord(value: object, keys: unknown
// ): value is Record<PropertyKey, string | string[]> {
//     if (typeof value !== "object" || value === null) return false
//     if (!Array.isArray(keys)) return false

//     const record = value as Record<PropertyKey, unknown>

//     return keys.every(
//         key =>
//             key in record &&
//             (typeof record[key] === "string" ||
//                 (Array.isArray(record[key]) &&
//                     record[key].every(v => typeof v === "string")))
//     )
// }

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