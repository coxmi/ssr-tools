import type { Provider } from './../../../vite/islands.ts'

const provider: Provider = {
	ssr: {
		name: 'ssr',
		importFrom: 'ssr-tools/islands/preact/ssr',
		importNamed: true
	},
	bundle({ imports, variables, code }) {
		return ''
			+ imports.join("\n") 
			+ "\n" 
			// import preact at the top level in the project scope:
			// otherwise resolves from the ssr-tools scope and doesn't deduplicate,
			// which results in undefined __H errors on the frontend
			+ `import "preact"` + "\n"
			+ `import { client as preactIslandClient } from "ssr-tools/islands/preact/client"` + "\n" 
			+ code.join("\n") + "\n"
			+ `preactIslandClient({` + "\n"
				+ variables.map(variable => `  ${variable}`).join(",\n") + "\n"
			+ '})'
	}
}

export default provider