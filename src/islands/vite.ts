import type { PluginOption, UserConfig, ResolvedConfig } from 'vite'
import * as vite from 'vite'
import * as recast from 'recast'
import { processIslands } from './process.ts'



export function islands(): PluginOption {
	
	let config: ResolvedConfig, 
		isSSR: boolean, 
		// name of manifest file or true for 'manifest.json'
		manifest: boolean | string 
	
	return {
		name: 'islands',
		configResolved(resolvedConfig) {
			config = resolvedConfig
			isSSR = !!config?.build.ssr
			manifest = config?.build.manifest
		},
		async transform(code, id) {
			if (!isSSR) return
			const matchJs = /\.(ts|js)x?$/i
			if (!matchJs.test(id)) return

			const ast = recast.parse(code, {
			  parser: { parse: this.parse },
			  sourceFileName: id,
			})

			const exported = processIslands(ast.program, {
				name: 'hydrate',
				importFrom: 'ssr-tools/hydrate/preact',
				importNamed: true
			})

			console.log(`————${id}————`)
			console.log(
				exported 
					? `Island exports: ${exported.join(', ')}`
					: 'No island exports'
			)
			console.log("\n")

			const { code: processed, map } = recast.print(ast, { 
				sourceMapName: 'unused-truthy-string-to-allow-sourcemaps' 
			})

			return { code: processed, map }
		},

		// 
		buildEnd(error) {
			// this.emitFile({
			// 	type: 'asset',
			// 	name: 'filename.js',
			// 	source: 'src'
			// })
			
		},
		generateBundle(options, bundle) {
		}
	}
}

function createClientCompiler(ssrUserConfig: UserConfig, ssrResolvedConfig: ResolvedConfig) {
	return vite.createServer({
	    ...ssrUserConfig,
	    // copy production/development mode from ssr resolved config
		mode: ssrResolvedConfig.mode,
		server: {
			...ssrUserConfig.server,
			// when parent compiler runs in middleware mode to support
			// custom servers, we don't want the child compiler also
			// run in middleware mode as that will cause websocket port conflicts
			middlewareMode: false,
		},
		configFile: false,
		envFile: false,
		plugins: [
			// ...(childCompilerConfigFile.config.plugins ?? [])
			...[].flat(),
			// Exclude this plugin from the child compiler to prevent an
			// infinite loop (plugin creates a child compiler with the same
			// plugin that creates another child compiler, repeat ad
			// infinitum), and to prevent the manifest from being written to
			// disk from the child compiler. This is important in the
			// production build because the child compiler is a Vite dev
			// server and will generate incorrect manifests.
			// .filter(plugin =>
			// 	typeof plugin === "object" &&
			// 	plugin !== null &&
			// 	"name" in plugin &&
			// 	// plugin.name !== "remix" &&
			// 	// plugin.name !== "remix-hmr-updates"
			// ),
			{
				name: "no-hmr",
				handleHotUpdate() {
				    // parent vite server is already sending HMR updates
				    // do not send duplicate HMR updates from child server
				    // which log confusing "page reloaded" messages that aren't true
				    return [];
				},
			},
		],
	});
}

