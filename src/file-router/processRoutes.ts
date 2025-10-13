import path from 'node:path'
import { styleText } from 'node:util'
import { writeFile, mkdir } from 'node:fs/promises'
import { MultiError } from '../utility/MultiError.ts'

import { 
	isBasic, 
	isDynamic, 
	type Route, 
	type RouteRequestData, 
	type ParamData 
} from './routes.ts'

import { 
	createFileRoute, 
	getPageProps, 
	env, 
	type FileRoute, 
	type UserHTMLTransform, 
	type Importer 
} from './fileRoute.ts'

import { 
	staticRequestFromPath, 
	extension, 
	isTextFormat 
} from './request.ts'


type BuildStaticItemOpts = {
	htmlTransform?: (html: string) => Promise<string>
	importer?: (path: string) => Promise<unknown>
	fixStacktrace?: (e: Error) => void
}

class BuildStaticItem {
	route: Route
	output: Array<[string, Response]> = []

	constructor(route: Route) {
		this.route = route
	}

	async buildStatic(options: BuildStaticItemOpts = {}): Promise<MultiError> {
		const { 
			htmlTransform = async html => html,
			importer = async (path: string) => await import(path),
			fixStacktrace = (e: Error) => {}
		} = options

		const pageErrors = new MultiError('', { 
			prefix: this.route.name,
			fixStacktrace
		})

		let compiled: FileRoute
		try {
			compiled = await createFileRoute(this.route, importer, env.STATIC)	
		} catch(e) {
			if (e instanceof Error) return pageErrors.add(e)
			return pageErrors
		}

		if (isBasic(this.route)) {
			const path = this.route.routepath
			const req = staticRequestFromPath(path)
			const props = getPageProps({ 
				req, 
				routeParams: {}, 
				props: {}
			})
			try {
				const res = await compiled.handler(props, htmlTransform)
				this.output.push([path, res])
			} catch(e) {
				if (e instanceof Error) pageErrors.add(e)
			}
		} else if (isDynamic(this.route)) {
			const from = [...await compiled.buildFrom()]

			await Promise.all(from.map(async item => {
				let urlProps: RouteRequestData
				try {
					urlProps = await compiled.buildUrl(item)
				} catch(e) {
					if (e instanceof Error) pageErrors.add(e)
					return
				}
				const { path, params } = urlProps
				const req = staticRequestFromPath(path)
				const props = getPageProps({ 
					req, 
					routeParams: params,
					props: item
				})

				try {
					const res = await compiled.handler(props, htmlTransform)
					this.output.push([path, res])
				} catch(e) {
					if (e instanceof Error) pageErrors.add(e)
					return
				}
			}))
		}
		return pageErrors
	}
}


/**
	Builds routes into static files. Usage:
	```ts
	const builder = new BuildStatic(route: Route, options)
	builder.build({ htmlTransform, importer })
	builder.write(outputDir, buildDir)
	```
*/

type BuildStaticOpts = {
	fixStacktrace?: (e: Error) => void
}

export class BuildStatic {
	builders: BuildStaticItem[] = []
	errors: MultiError
	processed: Record<string, string> = {}
	
	constructor(options: BuildStaticOpts = {}) {
		const {
			fixStacktrace = (e: Error) => {}
		} = options

		this.errors = new MultiError('(static) error while building pages', {
			fixStacktrace
		})
	}

	add(...routes: Route[]) {
		const builders = routes.map(route => new BuildStaticItem(route))
		this.builders.push(...builders)
	}

	async build(options: BuildStaticOpts = {}) {
		// build all routes
		const buildErrs = await Promise.all(this.builders.map(builder => builder.buildStatic(options)))
		this.errors.merge(...buildErrs)

		// dry run to check for duplicates
		await Promise.all(this.builders.map(async builder => {
			await Promise.all(builder.output.map(async (output) => {
				const [url, response] = output

				const body = await response.text()
				if (typeof body === 'undefined') {
					this.errors.add(new Error(`${url} – Nothing returned from handler`))
					return
				}

				const ext = extension(response)
				const filename = outputFileName(url, ext)
				const exists = this.processed[filename]	
				if (exists) {
					this.errors.add(new Error(`"${filename}" already exists, skipping duplicate`))
					return
				}
				this.processed[filename] = body
			}))
		}))

		if (this.errors.length) throw this.errors
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

		// TODO: use bundler logger if provided
		console.log(`${styleText('green', '✓')} Created ${number} static file${number === 1 ? '' : 's'}.`)	
		
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
		console.log(message)
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


type DevRequestHandlerArgs = {
	route: Route
	request: Request
	params: ParamData
	importer?: Importer
	htmlTransform?: UserHTMLTransform,
	fixStacktrace?: (e: Error) => void
}

export async function devRequestHandler(args: DevRequestHandlerArgs): Promise<Response> {

	const { 
		route, 
		request, 
		params, 
		importer = (path: string) => import(path), 
		htmlTransform = async html => html,
		fixStacktrace = () => {} 
	} = args

	let compiled: FileRoute
	const errors = new MultiError('(dev) error on route request handler', { 
		prefix: route.name, 
		fixStacktrace
	})
	
	try {
		compiled = await createFileRoute(route, importer, env.DEV)
	} catch(e) {
		if (e instanceof Error) {
			errors.add(e)
			throw errors
		}
	}

	async function handler() {
		const props = getPageProps({ 
			req: request, 
			routeParams: params,
			props: {}
		})
		return await compiled.handler(props, htmlTransform)
	}

	async function errorHandler(error: Error) {
		const props = {
			error,
			...getPageProps({ 
				req: request, 
				routeParams: params,
				props: {}
			})
		}
		return await compiled.errorHandler(props, htmlTransform)
	}

	try {
		return await handler()
	} catch(mainErr) {
		if (mainErr instanceof Error) {
			errors.add(mainErr)
			try {
				return await errorHandler(mainErr)	
			} catch(errorErr) {
				if (errorErr instanceof Error) {
					throw errors.add(errorErr)
				}
			}
		}
	}
	throw errors
}