import fs from 'node:fs'
import path from 'node:path'
import { parse as parseUrl } from 'node:url'
import { resolveConfig } from 'vite'
import glob from 'fast-glob'
import { isObject } from './../utility/object.ts'
import { buildRoutes, matchRoute } from './routes.ts'
import { addToHead, addToBody } from './html.ts'
import { sha } from './../utility/crypto.ts'
import serveStatic from 'serve-static'
import createRouter from 'router'
import { importUserModule } from '../utility/userEnv.ts'

import type { PluginOption, UserConfig, ResolvedConfig, ViteDevServer, ModuleNode } from 'vite'

type UserOptions = {
	dir: string,
	glob: string,
	removeTrailingSlash: boolean
}

type SettingsFromConfig = ReturnType<typeof settingsFromConfig>

/**
 * Vite plugin to allow ssr-tools:file-router in dev mode
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

	const stylesheets = new Map<string, CSS[]>()

	return {
		name: 'ssr-tools:file-router',

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

			// save stylesheets indexed per route for use in load hook
			const id = sha(ctx.path)
			const css = devCollectStyles(importedModules)			
			stylesheets.set(id, css)

			return [
				// remove the FOUC by including styles statically on first load
				{
					tag: 'link',
					attrs: {
						rel: 'stylesheet',
						href: `/@file-router-styles.css?v=${id}`,
					},
					injectTo: 'head'
				},
				// returns js imports, so vite handles css hmr as standard
				// the initial stylesheet is removed on load
				{
					tag: 'script',
					attrs: {
						type: 'module',
						src: `/@file-router-styles-dev?v=${id}`,
					},
					injectTo: 'body'
				},
				
				

			]
		},

		load(id, options) {
			if (options?.ssr) return
			const getStylesheets = (id: string) => {
				const sha = new URLSearchParams(id.split('?').pop()).get('v') || ''
				return stylesheets.get(sha) || []
			}
			if (id.startsWith('/@file-router-styles-dev?')) {
				return getStylesheets(id)
					.map(sheet => `import "${sheet.file}"`)
					.join('\n')
					+ `
					if (import.meta.hot) {
						const initial = document.querySelector('link[href^="/@file-router-styles.css"]')
						initial.remove()
					}
					`.replaceAll(/^\t{5}/gm, '')
			}
			if (id.startsWith('/@file-router-styles.css?')) {
				return getStylesheets(id).map(sheet => sheet.css).join('\n')
			}
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

				const imported = (await server.ssrLoadModule(importSource))
				let result = await handleImport(imported, req, res)
				if (result === false) return next()

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
	}, 'build')

	const plugin = viteConfig.plugins.find(plugin => plugin.name === 'ssr-tools:file-router')?.api
	if (!plugin) throw new Error(`No ssr-tools:file-router plugin found — please add to your vite config`)

	const userOptions = plugin.userOptions()

	const settings = settingsFromConfig(viteConfig, userOptions)
	if (!settings.manifestPathAbsolute) throw new Error(`No manifest found at ${settings.manifestPathAbsolute}`)

	const manifest = JSON.parse(fs.readFileSync(settings.manifestPathAbsolute, 'utf8'))

	const availableRoutes = buildRoutes({
		dir: settings.routerDirAbsolute,
		files: glob.sync(settings.routerGlobAbsolute),
		root: settings.root,
	})

	const main = async (req: any, res: any, next: any) => {

		const url = req.originalUrl
		
		if (typeof url !== 'string') return next()
		
		const matched = matchRoute(url, availableRoutes)
		if (!matched) return next()

		const filepathRelative = matched.component.startsWith('/') 
			? matched.component.slice(1)
			: matched.component

		const fileinfo = manifest[filepathRelative] 
		if (!fileinfo) return next()
		
		const importPath = path.join(settings.outDirAbsolute, fileinfo.file)
		const imported = await import(importPath)
		
		let html = await handleImport(imported, req, res)
		if (html === false) return next()

		// add scripts and styles to result from manifest
		const stylesheets = []
		if (manifest['style.css']) {
			const src = '/' + manifest['style.css'].file
			stylesheets.push(`<link rel="stylesheet" href="${src}">`)
		}

		const scripts = []
		if (manifest['client.js']) {
			const src = '/' + manifest['client.js'].file
			scripts.push(`<script src="${src}"></script>`)
		}

		if (stylesheets.length) html = addToHead(html, stylesheets)
		if (scripts.length) html = addToBody(html, scripts)

		if (res.writableEnded) return next()
		res.setHeader('Content-Type', 'text/html')
		return res.end(html)
	}

	const router = createRouter()

	// remove trailing slash if necessary
	if (userOptions.removeTrailingSlash) {
		router.use(middlewareRemoveTrailingSlash)
	}

	// add assets
	if (settings.assetsDirAbsolute) {
		router.use('/assets', serveStatic(settings.assetsDirAbsolute))
	}

	// add public directory
	if (viteConfig.publicDir) {
		router.use(serveStatic(viteConfig.publicDir))
	}

	router.use(main)
	return router
}


// problems with loading multiple versions of preact in dev when using `npm link`
// instead, import the module relative to the cwd
const { renderToString } = await importUserModule('preact-render-to-string')

async function handleImport(imported: any, req: any, res: any): Promise<string | false> {
	
	// TODO: parse and execute based on a pattern
	// e.g. native Response object

	let result = await imported.default(req, res)

	// no response, go to next middleware
	if (result === false || result === undefined) return false

	// allow string types as html
	if (typeof result === 'string') return result

	// preact element
	const isValidPreactElement = (result !== null && result.constructor === undefined)
	if (isValidPreactElement) {
		return renderToString(result, {}, { pretty: true, jsx: false })
	}

	return false
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


type CSS = { id: string, file: string, css: string }

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
      			file: mod.file || '',
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