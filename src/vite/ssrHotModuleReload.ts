import type { Plugin, EnvironmentModuleNode } from 'vite'

// from: https://github.com/withastro/astro/blob/63ca266b9039ed241ee5257d1b2e6b2337a041c9/packages/astro/src/vite-plugin-hmr-reload/index.ts
// to fix: https://github.com/vitejs/vite/issues/19114

export function ssrHotModuleReload(): Plugin {
	return {
		name: 'ssr-tools:ssr-hot-module-reload',
		enforce: 'post',
		hotUpdate: {
			order: 'post',
			handler({ modules, server, timestamp }) {
				if (this.environment.name !== 'ssr') return
				let hasSsrOnlyModules = false
				const invalidatedModules = new Set<EnvironmentModuleNode>()
				for (const mod of modules) {
		  			if (mod.id === null) continue
					const clientModule = server.environments.client.moduleGraph.getModuleById(mod.id)
					if (clientModule) continue
					hasSsrOnlyModules = true
					this.environment.moduleGraph.invalidateModule(mod, invalidatedModules, timestamp, true);
				}

				if (hasSsrOnlyModules) {
					server.ws.send({ type: 'full-reload' })
					return [];
				}
				return
			},
		},
	}
}