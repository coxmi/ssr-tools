import fs from 'node:fs'
import path from 'node:path'
import { parse as parseUrl } from 'node:url'
import { resolveConfig } from 'vite'
import type { PluginOption, UserConfig, ResolvedConfig, ViteDevServer, ModuleNode } from 'vite'
import { isObject } from './../utility/object.ts'
import glob from 'fast-glob'
import { buildRoutes, matchRoute } from './routes.ts'
import { addToHead, addToBody } from './html.ts'

type UserOptions = {
	dir: string,
	glob: string,
	removeTrailingSlash: boolean
}

type SettingsFromConfig = ReturnType<typeof settingsFromConfig>

/**
 * Vite plugin to allow file-router in dev mode
 */
export function fileRouter(opts: UserOptions): PluginOption {

	// save server in plugin scope to access later in dev mode load step
	let server: ViteDevServer
	let settings: SettingsFromConfig

	// default options
	const defaults: UserOptions = { 
		dir: 'src/pages', 
		glob: '**/*.{ts,tsx,js,jsx}', 
		removeTrailingSlash: true
	}

	const userOptions = { 
		...defaults, 
		...(isObject(opts) ? opts : {}) 
	}

	return {
		name: 'file-router',

		api: {
			userOptions: () => userOptions,
			settings: () => settings,
		},

		config(config) {
			// add all matching glob files to rollupOptions
			const root = config.root || process.cwd()
			const routerDirAbsolute = toAbsolutePath(userOptions.dir, root)
			const routerGlobAbsolute = toAbsolutePath(userOptions.glob, routerDirAbsolute)
			return {
				build: {
					rollupOptions: {
						input: glob.sync(routerGlobAbsolute),
						// specify chunks and entry names, otherwise vite puts them into 'assets'
						output: {
							entryFileNames: "routes/[name].js",
							chunkFileNames: "routes/chunks/[name]-[hash].js",
						}
					},
				}
			}
		},

		configResolved(resolvedConfig) {
			settings = settingsFromConfig(resolvedConfig, userOptions)
		},

		/** 
		 * adds ssr css to page when in dev mode
		 */
		transformIndexHtml(html, ctx) {
			if (!ctx.server) return
			
			const importSource = devFindRoute(settings, ctx.path)
			if (typeof importSource !== 'string') return

			const importedModules = ctx.server.moduleGraph.getModulesByFile(importSource)
			if (!importedModules) return

			const styles = devCollectStyles(importedModules)
			return styles.map(style => ({
				tag: 'style',
				attrs: { 
					"type": "text/css",
					"data-vite-dev-id": style.id
				},
				children: "\n" + style.css + "\n",
				injectTo: 'head'
			}))
		},

		configureServer(server) {

	    	server.watcher.add([
	    		settings.routerDirAbsolute, 
	    		settings.routerGlobAbsolute
	    	])

	    	if (userOptions.removeTrailingSlash) {
	    		server.middlewares.use(middlewareRemoveTrailingSlash)
	    	}

			server.middlewares.use(async (req, res, next) => {
				const url = req.originalUrl
				if (typeof url !== 'string') return next()
				
				const importSource = devFindRoute(settings, url)
				if (typeof importSource !== 'string') return next()

				const handler = (await server.ssrLoadModule(importSource)).default

				// TODO: parse and execute based on a pattern
				// e.g. native Response object, preact component default
				const result = await handler(req, res)

				// in dev, allow hmr and plugins to edit output
				const html = await server.transformIndexHtml(url, result)

				if (res.writableEnded) return next()
				res.setHeader('Content-Type', 'text/html')
				return res.end(html)
			})
		  },
	}
}

/**
 * Middleware that initialises the file router with settings from vite plugin
 */
export async function fileRouterMiddleware(configPathOrFolder: string = '') {

	const configFile = findConfigFile(configPathOrFolder)
	const viteConfig = await resolveConfig({
		configFile: configFile
	})

	const plugin = viteConfig.plugins.find(plugin => plugin.name === 'file-router')?.api
	if (!plugin) throw new Error(`No file-router plugin found — please add to your vite config`)

	const userOptions = plugin.userOptions()

	const settings = settingsFromConfig(viteConfig, userOptions)
	if (!settings.manifestPathAbsolute) throw new Error(`No manifest found at ${settings.manifestPathAbsolute}`)

	const manifest = JSON.parse(fs.readFileSync(settings.manifestPathAbsolute, 'utf8'))

	const availableRoutes = buildRoutes({
		dir: settings.routerDirAbsolute,
		files: glob.sync(settings.routerGlobAbsolute),
		root: settings.root,
	})

	const main = async (req, res, next) => {

		const url = req.originalUrl
		
		if (typeof url !== 'string') return next()
		
		const matched = matchRoute(url, availableRoutes)
		if (!matched) return next()

		const filepathRelative = matched.component.startsWith('/') 
			? matched.component.slice(1)
			: matched.component

		const fileinfo = manifest[filepathRelative] 
		if (!fileinfo) return next()
		
		const importBuilt = path.join(settings.outDirAbsolute, fileinfo.file)
		const handler = (await import(importBuilt)).default

		// TODO: parse and execute based on a pattern
		// e.g. native Response object, preact component default
		let html = await handler(req, res)

		// add scripts and styles to result from manifest
		const stylesheets = []
		if (manifest['style.css']) {
			const src = '/' + manifest['style.css'].file
			stylesheets.push(`<link rel="stylesheet" href="${src}">`)
		}

		const scripts = []
		if (manifest['islands-client.js']) {
			const src = '/' + manifest['islands-client.js'].file
			scripts.push(`<script src="${src}"></script>`)
		}

		if (stylesheets.length) html = addToHead(html, stylesheets)
		if (scripts.length) html = addToBody(html, scripts)

		if (res.writableEnded) return next()
		res.setHeader('Content-Type', 'text/html')
		return res.end(html)
	}

	const preMiddlewares = []
	if (userOptions.removeTrailingSlash) preMiddlewares.push(middlewareRemoveTrailingSlash)

	/* @ts-ignore */
	return combineMiddleware([
		...preMiddlewares,
		main
	])
}


export function settingsFromConfig(config: ResolvedConfig, userOptions: UserOptions) {

	const root = config.root
	const outDirAbsolute = toAbsolutePath(config.build.outDir, root)
	const assetsDirAbsolute = toAbsolutePath(config.build.assetsDir, outDirAbsolute)
	const routerDirAbsolute = toAbsolutePath(userOptions.dir, root)
	const routerGlobAbsolute = toAbsolutePath(userOptions.glob, routerDirAbsolute)
	
	let manifest = config?.build?.manifest
	let manifestFileName: string = ''
	if (manifest && typeof manifest === 'boolean') manifestFileName = '.vite/manifest.json'
	if (manifest && typeof manifest === 'string') manifestFileName = manifest

	const manifestPathAbsolute = manifestFileName
		? path.resolve(outDirAbsolute, manifestFileName) 
		: null

	return {
		root, 
		outDirAbsolute, 
		assetsDirAbsolute, 
		manifestPathAbsolute,
		routerDirAbsolute,
		routerGlobAbsolute
	}
}


function devFindRoute(settings: SettingsFromConfig, url: string) {
	const availableRoutes = buildRoutes({
		dir: settings.routerDirAbsolute,
		files: glob.sync(settings.routerGlobAbsolute),
		root: settings.root,
	})
	if (!availableRoutes.length) return null
	
	const matched = matchRoute(url, availableRoutes)
	if (!matched) return null

	const filepathRelative = matched.component.startsWith('/') 
		? matched.component.slice(1)
		: matched.component

	const importSource = path.join(settings.root, filepathRelative)
	return importSource
}


type CSS = { id: string, css: string }

// adapted from https://github.com/vitejs/vite/issues/2282
function devCollectStyles(modules: Set<ModuleNode>, styles: Record<string, CSS> = {}, checkedComponents = new Set()) {
	for (const mod of modules) {
		const isCss = mod.ssrModule && (
			mod.file?.endsWith(".css") ||
			mod.file?.endsWith(".scss") ||
        	mod.file?.endsWith(".less")
        )
		
		if (isCss && mod.ssrModule?.default) {
      		styles[mod.url] = {
      			id: mod.url,
      			css: mod.ssrModule?.default
      		}
    	}

    	if (mod.importedModules.size > 0 && !checkedComponents.has(mod.id)) {
      		checkedComponents.add(mod.id)
      		devCollectStyles(mod.importedModules, styles, checkedComponents)
    	}
  	}

  	return Object.values(styles)
}


function findConfigFile(configPathOrFolder: string = process.cwd()) {
	
	let test = configPathOrFolder
	
	// convert to abs
	if (!test.startsWith('/')) {
		test = path.join(process.cwd(), test)
	}

	if (fs.existsSync(test)) {
		const stat = fs.lstatSync(test)
		if (stat.isDirectory()) {
			const matches = glob.sync([
				path.join(test, 'vite.config.ts'),
				path.join(test, 'vite.config.js'),
			])
			if (matches.length) return matches[0]
		}
		if (stat.isFile()) {
			return test
		}
	}
	throw new Error(`No config file found at ${test}`)
}


function middlewareRemoveTrailingSlash(req, res, next) {
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

function toAbsolutePath(to: string, from: string = process.cwd()): string {
	if (to.startsWith('/')) return to
	if (!from.startsWith('/')) throw new Error('"from" must be an absolute path')
	return path.join(from, to)
}


/**
 * Combine multiple middleware together.
 *
 * @param middlewares functions of form:
 *   function(req, res, next) { ... }
 * @return single combined middleware
 */
function combineMiddleware(middlewares: Array<(...arg: any[]) => any>) {
	// taken from https://stackoverflow.com/a/32640935
	if (middlewares.length === 1) return middlewares[0]
	return middlewares.reduce(function(a, b) {
		return function(req, res, next) {
			a(req, res, function(err: any) {
				if (err) return next(err)
        		b(req, res, next)
      		})
    	}
  	})
}