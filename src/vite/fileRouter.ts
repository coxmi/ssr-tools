import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from 'vite'
import glob from 'fast-glob'
import { isObject } from './../utility/object.ts'
import { buildRoutes } from './../file-router/routes.ts'
import { addToHead, addToBody } from './../file-router/html.ts'
import { sha } from './../utility/crypto.ts'
import serveStatic from 'serve-static'
import * as middleware from './../file-router/middleware.ts'
import { requestHandler } from './../file-router/request.ts'

import type { CSS } from './utility.ts'
import { devStyles, findConfigFile, toAbsolutePath } from './utility.ts'

// @ts-ignore
import createRouter from 'router'


import type { PluginOption, ResolvedConfig, ViteDevServer, ModuleNode } from 'vite'

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
	let server: ViteDevServer
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

	return {
		name: 'ssr-tools:file-router',
		enforce: 'post',

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
					// needs manifest for serving files later
					manifest: true,
					// needs static build assets
					ssrEmitAssets: true,

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

	const matchRoute = buildRoutes({
		dir: settings.routerDirAbsolute,
		files: glob.sync(settings.routerGlobAbsolute),
		root: settings.root,
		remapFiles: importPath => {
			// use manifest to have buildRoutes match against the built files rather than source
			const importPathRelative = importPath.replace(settings.root + '/', '')
			const routeInfo = manifest[importPathRelative]
			if (!routeInfo) return false
			return path.join(settings.outDirAbsolute, routeInfo.file)
		}
	})

	const main = async (req: any, res: any, next: any) => {

		const url = req.originalUrl
		if (typeof url !== 'string') return next()
		const matchedRoute = matchRoute(url)

		/**
		 * TODO:
		 * • `style.css` is hardcoded when (build.cssCodeSplit === false) in vite.config.ts
		 *    When true, we'll need to walk the graph of imports for css/js
		 * 
		 * • `client.js` will pull through from islands (double check title, may be better to be islands.js)
		 * 
		 */

		// add scripts and styles to result from manifest
		const stylesheets: string[] = []
		if (manifest['style.css']) {
			const src = '/' + manifest['style.css'].file
			stylesheets.push(`<link rel="stylesheet" href="${src}">`)
		}

		const scripts: string[] = []
		if (manifest['client.js']) {
			const src = '/' + manifest['client.js'].file
			scripts.push(`<script src="${src}"></script>`)
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
		router.use('/assets', serveStatic(settings.assetsDirAbsolute))
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


function devMatchRoute(settings: SettingsFromConfig, url: string) {
	const matchRoute = buildRoutes({
		dir: settings.routerDirAbsolute,
		files: glob.sync(settings.routerGlobAbsolute),
		root: settings.root,
	})
	return matchRoute(url)
}