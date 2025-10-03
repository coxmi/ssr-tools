import fs from 'fs-extra'
import path from 'node:path'
import { resolveConfig } from 'vite'
import glob from 'fast-glob'
import globToRegexp from 'glob-to-regexp'
import serveStatic from 'serve-static'
import { addToHead, addToBody } from './../file-router/html.ts'
import { buildRoutes } from './../file-router/routes.ts'
import { RouteBatchProcess } from './../file-router/processRoutes.ts'
import * as middleware from './../file-router/middleware.ts'
import { requestHandler } from './../file-router/request.ts'
import { devStyles, findConfigFile, toAbsolutePath } from './utility.ts'
import { isObject } from './../utility/object.ts'
import { sha } from './../utility/crypto.ts'
import { ssrHotModuleReload } from './ssrHotModuleReload.ts'

import type { CSS } from './utility.ts'
import type { PluginOption, ResolvedConfig } from 'vite'
import type { OutputChunk, OutputAsset } from 'rollup'

// @ts-ignore
import createRouter from 'router'


type NonOptional<T> = { 
	[K in keyof Required<T>]: Exclude<T[K], undefined> 
}

type FileRouterUserOptions = {
	dir?: string,
	glob?: string,
	removeTrailingSlash?: boolean
}

type FileRouterOptions = NonOptional<FileRouterUserOptions>
type SettingsFromConfig = ReturnType<typeof settingsFromConfig>

/**
 * Vite plugin to allow ssr-tools:file-router in dev mode
 */
export function fileRouter(opts: FileRouterUserOptions): PluginOption {

	// save server in plugin scope to access later in dev mode load step	
	let config: ResolvedConfig
	let settings: SettingsFromConfig

	// default options
	const defaults: FileRouterOptions = { 
		dir: 'src/pages', 
		glob: '**/*.{ts,tsx,js,jsx}', 
		removeTrailingSlash: true
	}

	const userOptions = { 
		...defaults, 
		...(isObject(opts) ? opts : {}) 
	}

	const stylesheets = new Map<string, CSS[]>()
	let matchFiles: RegExp

	return [
		ssrHotModuleReload(),
		{
			name: 'ssr-tools:file-router',
			enforce: 'post',

			api: {
				userOptions: () => userOptions
			},

			config(config) {

				// add all matching glob files to rollupOptions
				const root = config.root || process.cwd()
				const routerDirAbsolute = toAbsolutePath(userOptions.dir, root)
				const routerGlobAbsolute = toAbsolutePath(userOptions.glob, routerDirAbsolute)

				// save regex to test file paths later
				matchFiles = globToRegexp(routerGlobAbsolute, { 
					extended: true,
					globstar: true
				})

				// remap entry file names to /server/[default] if the files are part of the glob
				// use getDefaultChunkOption to simplify output fns below
				const getDefaultChunkOption = function(x: string | ((arg: any) => string), chunk: any): string {
					return typeof x === 'function' ? x(chunk) : x
				}
				// @ts-ignore
				const defaultEntryFileNames = config.build?.rollupOptions?.output?.entryFileNames || '[name].js'
				// @ts-ignore
				const defaultChunkFileNames = config.build?.rollupOptions?.output?.chunkFileNames || '[name]-[hash].js'

				return {
					build: {
						// requires manifest for serving files in build
						manifest: true,
						// requires ssr assets for included image, style, and script assets
						ssrEmitAssets: true,
						rollupOptions: {
							// include the routes as entrypoints
							input: glob.sync(routerGlobAbsolute),
							// if files are routes, send them to server output folder, 
							// otherwise use the previously defined config options
							output: {
								entryFileNames: chunk => {
									let name = ''
									if (chunk.facadeModuleId && matchFiles.test(chunk.facadeModuleId)) name += "server/"
									name += getDefaultChunkOption(defaultEntryFileNames, chunk)
									return name
								},
								chunkFileNames: chunk => {
									return "server/chunks/" + getDefaultChunkOption(defaultChunkFileNames, chunk)
								}
							}
						},
					}
				}
			},

			configResolved(resolvedConfig) {
				config = resolvedConfig
				settings = settingsFromConfig(resolvedConfig, userOptions)
			},

			/** 
			 * adds ssr css to page when in dev mode
			 */
			async transformIndexHtml(html, ctx) {
				if (!ctx.server) return

				// TODO: [...all.ts] also matches on .well-known/ and other dotfiles
				// what's the preferred solution to this?
				const matched = devMatchRoute(settings, ctx.path)
				if (!matched.route) return

				const importedModules = ctx.server.moduleGraph.getModulesByFile(matched.route.module)
				if (!importedModules) return

				// save stylesheets indexed per route for use in load hook
				const id = sha(ctx.path)
				const css = await devStyles(importedModules, ctx.server)
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
					}
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
		    		server.middlewares.use(middleware.removeTrailingSlash)
		    	}

				return () => {
					server.middlewares.use(async (req, res, next) => {
						const url = req.originalUrl
						if (typeof url !== 'string') return next()
						const matchedRoute = devMatchRoute(settings, url)
						await requestHandler({
							url,
							matchedRoute,
							importer: server.ssrLoadModule,
							htmlTransform: html => server.transformIndexHtml(url, html),
							ctx: { req, res, next }
						})
					})
				}
			},

			async writeBundle(options, bundle) {

				// copy assets to server directory
				fs.cpSync(
					settings.assetsDirAbsolute, 
					settings.ssrAssetsDirAbsolute,
					{ recursive: true }
				);

				// remove the top-level assets directory later, after we've moved 
				// or copied it to ssr and static
				const toRemove = path.join(settings.buildDirAbsolute, config.build.assetsDir.split('/')[0])
				const remove = () => fs.rmSync(toRemove, { recursive: true, force: true })
				
				// gather chunks and assets from bundle
				const chunks: OutputChunk[] = []
				const assets: Record<string, OutputAsset> = {}
				for (const file of Object.values(bundle)) {
					if (file.type === 'asset' && file.names[0]) {
						assets[file.names[0]] = file
					}
					if (file.type === 'chunk' 
						&& file.isEntry 
						&& file.facadeModuleId 
						&& matchFiles.test(file.facadeModuleId)) {
						chunks.push(file)
					}
				}

				if (!chunks.length) return remove()

				// copy assets to static directory and delete original assets
				fs.cpSync(settings.assetsDirAbsolute, settings.staticAssetsDirAbsolute, {recursive: true });
				remove()

				// build routes for compilation
				const routes = buildRoutes({
					dir: settings.routerDirAbsolute,
					files: glob.sync(settings.routerGlobAbsolute)
				})

				// gather scripts and styles to result from bundle manifest
				const stylesheets: string[] = []
				if (assets['style.css']) {
					const src = '/' + assets['style.css'].fileName
					stylesheets.push(`<link rel="stylesheet" href="${src}">`)
				}
				const scripts: string[] = []
				if (assets['client.js']) {
					const src = '/' + assets['client.js'].fileName
					scripts.push(`<script src="${src}"></script>`)
				}

				const proc = new RouteBatchProcess()

				await Promise.all(chunks.map(async chunk => {
					if (!chunk.facadeModuleId) return
					const route = routes.findRouteByFile(chunk.facadeModuleId)
					const compiledPath = path.join(settings.buildDirAbsolute, chunk.fileName)
					if (!route) return
					const exported = await import(compiledPath)
					proc.add(route, exported)
				}))

				await proc.buildStatic({ 
					htmlTransform: html => {
						if (stylesheets.length)  html = addToHead(html, stylesheets)
						if (scripts.length) html = addToBody(html, scripts)
						return html
					}
				})

				await proc.write(
					settings.staticBuildDirAbsolute,
					settings.buildDirAbsolute
				)
			}
		}
	]
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
	if (!settings.manifestPathAbs) throw new Error(`No manifest found at ${settings.manifestPathAbs}`)

	const manifest = JSON.parse(fs.readFileSync(settings.manifestPathAbs, 'utf8'))

	const routes = buildRoutes({
		dir: settings.routerDirAbsolute,
		files: glob.sync(settings.routerGlobAbsolute),
		remapFiles: importPath => {
			// use manifest to have buildRoutes match against the built files rather than source
			const importPathRelative = importPath.replace(settings.root + '/', '')
			const routeInfo = manifest[importPathRelative]
			if (!routeInfo) return false
			return path.join(settings.buildDirAbsolute, routeInfo.file)
		}
	})

	const main = async (req: any, res: any, next: any) => {

		const url = req.originalUrl
		if (typeof url !== 'string') return next()
		const matchedRoute = routes.matchRoute(url)

		/**
		 * TODO:
		 * • `style.css` is hardcoded when (build.cssCodeSplit === false) in vite.config.ts
		 *    When true, we'll need to walk the graph of imports for css/js
		 * 
		 * • `client.js` will pull through from islands plugins and client plugins
		 */

		// add scripts and styles to result from manifest
		const stylesheets: string[] = []
		if (manifest['style.css']) {
			const src = manifest['style.css'].file
			stylesheets.push(`<link rel="stylesheet" href="/${src}">`)
		}

		const scripts: string[] = []
		if (manifest['client.js']) {
			const src = manifest['client.js'].file
			scripts.push(`<script src="/${src}"></script>`)
		}

		await requestHandler({
			url,
			matchedRoute,
			htmlTransform: html => {
				if (stylesheets.length) html = addToHead(html, stylesheets)
				if (scripts.length) html = addToBody(html, scripts)
				return html
			},
			ctx: { req, res, next }
		})		
	}

	const router = createRouter()

	// remove trailing slash if necessary
	if (userOptions.removeTrailingSlash) {
		router.use(middleware.removeTrailingSlash)
	}

	// add assets
	if (settings.assetsDirAbsolute) {
		const pathToAssets = '/' + path.relative(settings.buildDirAbsolute, settings.assetsDirAbsolute)
		router.use(pathToAssets, serveStatic(settings.ssrAssetsDirAbsolute))
	}

	// add public directory
	if (viteConfig.publicDir) {
		router.use(serveStatic(viteConfig.publicDir))
	}

	router.use(main)
	return router
}


export function settingsFromConfig(config: ResolvedConfig, userOptions: FileRouterOptions) {

	const root = config.root

	// vite build directories
	const buildDirAbsolute = toAbsolutePath(config.build.outDir, root)
	const assetsDirAbsolute = toAbsolutePath(config.build.assetsDir, buildDirAbsolute)
	const routerDirAbsolute = toAbsolutePath(userOptions.dir, root)
	const routerGlobAbsolute = toAbsolutePath(userOptions.glob, routerDirAbsolute)

	// ssr/static build output directories
	const ssrBuildDirAbsolute = path.join(buildDirAbsolute, 'server')
	const staticBuildDirAbsolute = path.join(buildDirAbsolute, 'html')
	const ssrAssetsDirAbsolute = path.join(ssrBuildDirAbsolute, config.build.assetsDir)
	const staticAssetsDirAbsolute = path.join(staticBuildDirAbsolute, config.build.assetsDir)
	
	let manifest = config?.build?.manifest
	let manifestFileName: string = ''
	if (manifest && typeof manifest === 'boolean') manifestFileName = '.vite/manifest.json'
	if (manifest && typeof manifest === 'string') manifestFileName = manifest

	const manifestPathAbs = manifestFileName
		? path.resolve(buildDirAbsolute, manifestFileName) 
		: null

	return {
		root, 
		buildDirAbsolute, 
		ssrBuildDirAbsolute,
		staticBuildDirAbsolute,
		assetsDirAbsolute, 
		ssrAssetsDirAbsolute,
		staticAssetsDirAbsolute,
		manifestPathAbs,
		routerDirAbsolute,
		routerGlobAbsolute
	}
}


function devMatchRoute(settings: SettingsFromConfig, url: string) {
	const routes = buildRoutes({
		dir: settings.routerDirAbsolute,
		files: glob.sync(settings.routerGlobAbsolute),
	})
	return routes.matchRoute(url)
}