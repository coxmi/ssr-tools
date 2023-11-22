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

			const { code: processed, map } = recast.print(ast, { 
				sourceMapName: 'unused-truthy-string-to-allow-sourcemaps' 
			})

			return { code: processed, map }
		},
		buildEnd(error) {
		},
		generateBundle(options, bundle) {}
	}
}

