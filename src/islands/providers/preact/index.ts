import type { Provider } from './../../vite.ts'

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
			+ `import { client as preactIslandClient } from "ssr-tools/islands/preact/client"` + "\n" 
			+ code.join("\n") + "\n"
			+ `preactIslandClient({` + "\n"
				+ variables.map(variable => `  ${variable}`).join(",\n") + "\n"
			+ '})'
	}
}

export default provider