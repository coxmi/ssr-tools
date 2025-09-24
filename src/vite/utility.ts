import path from 'node:path'
import fs from 'node:fs'
import glob from 'fast-glob'

import type { ModuleNode, ViteDevServer } from 'vite'

export type CSS = { id: string | null, file: string | null, css: string | null }

/**
 * Collects styles from module graph
 * (adapted from https://github.com/vitejs/vite/issues/2282)
 */
export async function devStyles(
	modules: Set<ModuleNode>, 
	server: ViteDevServer
) {
	const styleModules = await devCollectStyleModules(modules)
	const styleInfoPromises = styleModules.map(async mod => {
		let css = mod?.ssrModule?.default
		if (typeof css !== 'string') {
			// Vite 5 doesn't allow css imports in SSR dev any more (https://github.com/vitejs/vite/issues/19205)
			// so we have to force load the module here with `?inline` if it doesn't already return a string
			css = (await server.ssrLoadModule(mod.file + '?inline')).default
		}
		return {
			id: mod.id,
			file: mod.file,
			css: typeof css === 'string' ? css : ''
		}
	})
	return await Promise.all(styleInfoPromises)
}

function devCollectStyleModules(
	modules: Set<ModuleNode>, 
	styles: Record<string, ModuleNode> = {}, 
	checkedComponents = new Set()
) {

	for (const mod of modules) {
		const isCss = mod.ssrModule && (
			mod.file?.endsWith(".css") ||
			mod.file?.endsWith(".scss") ||
        	mod.file?.endsWith(".less")
        )
        if (isCss) styles[mod.url] = mod
    	if (mod.importedModules.size > 0 && !checkedComponents.has(mod.id)) {
      		checkedComponents.add(mod.id)
      		devCollectStyleModules(mod.importedModules, styles, checkedComponents)
    	}
  	}
  	return Object.values(styles)
}

/**
 * Find vite config file 
 * Defaults to current working directory
 */
export function findConfigFile(configPathOrFolder: string = process.cwd()): string {
	
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


export function toAbsolutePath(to: string, from: string = process.cwd()): string {
	if (to.startsWith('/')) return to
	if (!from.startsWith('/')) throw new Error('"from" must be an absolute path')
	return path.join(from, to).replace(/\/$/, '')
}