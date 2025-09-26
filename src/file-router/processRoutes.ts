import type { Route } from './routes.ts'
import type { ParsedRouteResult } from './request.ts'
import { isStatic, isDynamic } from './routes.ts'
import { writeFile, mkdir } from 'node:fs/promises'
import { getPageProps, parseRouteResponse } from './request.ts'
import path from 'node:path'

type BuildStaticArgs = {
	htmlTransform?: (html: string) => string
}

/**
	Processes exported route. Usage:
	```
	const proc = new RouteProcess(route: Route, exported: any)
	proc.buildStatic(outputDir)
	````

	Exported route must be in the form:
	```
	export async function props(): {
		return [{ slug: 1 }, { slug: 2 }]
	}

	export function routeParams(props){
		 return { 
		 	slug: props.slug,
		 }
	}

	export default ({ req, res, ctx }: PageProps<Props>) => {
		return <html>
			<body>
				{JSON.stringify(ctx.params)}
			</body>
		</html>
	}
	```
*/

class RouteProcess {

	route: Route
	exported: any
	output: Array<[string, ParsedRouteResult]> = []
	
	// props: Record<string, any> = {}
	// routeParams: Array<Record<string, string | string[]>> = []
	// urls: string[] = []
	// singleUrl: string | undefined

	constructor(route: Route, exported: any) {
		this.route = route
		this.exported = exported
	}

	async buildStatic(args: BuildStaticArgs = {}): Promise<RouteProcessErrors> {

		const { htmlTransform = html => html } = args

		// TODO: handle errors
		const err = new RouteProcessErrors()
		err.merge(
			RouteProcess.parseExportedCommon(this.route, this.exported),
			RouteProcess.parseExportedBuild(this.route, this.exported)
		)

		if (isStatic(this.route)) {
			// routes without a dynamic url only render a single url with no params
			// so we skip the props/routeParams steps
			const url = this.route.routepath
			const routeParams = {}
			const props = getPageProps({ url, routeParams })
			const output = await this.exported.default(props)
			const parsed = await parseRouteResponse(output, this.route.name)
			if (parsed.headers['Content-Type'] === 'text/html') {
				if (parsed.body) parsed.body = htmlTransform(parsed.body)
			}
			this.output.push([ url, parsed ])

		} else if (isDynamic(this.route)) {
			// const props = await this.exported.props()
		}

		return err
	}

	/**
	 * Common error handling for statically built and dynamic runtime routes
	 */
	static parseExportedCommon(route: Route, exported: any): RouteProcessErrors {
		const err = new RouteProcessErrors()
		if (!exported.default)
			err.add(`No default export found in "${route.module}". Did you export the route function?`)

		if (exported.default && typeof exported.default !== 'function') {
			err.add(
				`Routes must export a function.\n` 
				+ `"${route.module}" exported \`${typeof exported.default}\``
			)
		}
		return err
	}

	/**
	 * Error handling for statically built routes
	 */
	static parseExportedBuild(route: Route, exported: any): RouteProcessErrors {
		const err = new RouteProcessErrors()
		if (isDynamic(route)) {
			err.add(`Trying to build dynamic route: "${route.module}"`)
			err.last(
				`Dynamic paths cannot currently be built statically.\n` 
				+ `If you'd like to see this feature, Please raise an issue at:\n` 
				+ `https://github.com/coxmi/ssr-tools/issues`
			)
		} else if (isStatic(route)) {
			if (exported.routeParams) {
				err.add(
					`\`routeParams\` was not used when creating pages for route "${route.module}":\n`
					+ `Use a dynamic file name to generate multiple pages`
				)
			}
		}
		return err
	}

	// static async getProps(obj: RouteProcess) {
	// 	obj.props = await obj.exported.props()
	// }

	// static async getRouteParams(obj: RouteProcess) {
	// 	obj.routeParams = await obj.exported.routeParams(obj.props)
	// }

	// static async getUrls(obj: RouteProcess) {
	// 	obj.routeParams
	// 	// const urlawait obj.exported.default(props)
	// }
}

export class RouteBatchProcess {
	routes: RouteProcess[] = []
	errors: RouteProcessErrors = new RouteProcessErrors()
	
	add(route: Route, exported: any) {
		const proc = new RouteProcess(route, exported)
		this.routes.push(proc)
	}

	async buildStatic(args: BuildStaticArgs = {}) {
		const errors = await Promise.all(this.routes.map(proc => proc.buildStatic(args)))
		this.errors.merge(...errors)
	}

	async write(outputDir: string) {
		const processed: Record<string, string> = {}
		
		this.routes.map(proc => {
			for (const out of proc.output) {
				const [url, parsed] = out
				if (typeof parsed.body === 'undefined') continue
				const filename = outputFileName(url, parsed.ext)
				const outputPath = path.join(outputDir, filename)
				const exists = processed[outputPath]	
				if (exists) {
					this.errors.add(`"${url}" already exists, skipping duplicate`)
					continue
				}
				processed[outputPath] = parsed.body
			}
		})

		this.errors.log(console.log)
		// TODO: determine which errors should stop the build process

		const num = Object.keys(processed).length
		await Promise.all(
			Object.entries(processed).map(async ([file, body]) => {
				await emitFile(file, body)
			})
		)
		
		console.log(`Created ${num} static file${num === 1 ? '' : 's'} in ${outputDir}`)
	}
}

class RouteProcessErrors {
	// dedupes errors using object keys
	private errors: Record<string, Boolean> = {}
	private lastErrors: Record<string, Boolean> = {}
	private countErrors = 0

	add(message: string) {
		if (this.errors[message]) return
		this.errors[message] = true
		this.countErrors++
	}

	last(message: string) {
		if (this.lastErrors[message]) return
		this.lastErrors[message] = true
		this.countErrors++
	}

	merge(...errs: RouteProcessErrors[]) {
		Object.assign(this.errors, ...(errs.map(err => err.errors)))
		Object.assign(this.lastErrors, ...(errs.map(err => err.lastErrors)))
		this.countErrors = Object.values(this.errors).length + Object.values(this.lastErrors).length
	}

	log(logger: (message: string) => void = console.log) {
		logger('')
		Object.keys(this.errors).map(message => logger(message))
		logger('')
		Object.keys(this.lastErrors).map(message => logger(message))
		logger('')
	}

	count() {
		return this.countErrors
	}
}


function outputFileName(path: string, type:string = '') {
	if (path.endsWith('/')) {
		return path + 'index' + (type ? `.${type}` : '')
	}
	return path
}


async function emitFile(outputPath: string, contents: string) {
	await mkdir(path.dirname(outputPath), { recursive: true })
	await writeFile(outputPath, contents, { flag: 'w+' })
}