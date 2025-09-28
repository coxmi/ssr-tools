import type { Provider } from './../../../vite/islands.ts'

const provider: Provider = {
	ssr: {
		// name of the exported property in the `importFrom` file
		name: 'ssr',
		// the file to include 
		importFrom: 'ssr-tools/islands/preact/ssr',
		// whether the exported property is named (or is a default export)
		importNamed: true
	},
	bundle({ imports, variables, code }) {
		return ''
			// piece together the imports needed in the front-end bundle
			+ imports.join("\n") 
			+ "\n" 
			
			// import preact at the top level in the project scope:
			// otherwise resolves from the ssr-tools scope and doesn't deduplicate,
			// which results in undefined __H errors on the frontend
			+ `import "preact"` + "\n"
			+ `import { client as preactIslandClient } from "ssr-tools/islands/preact/client"` + "\n" 
			
			// append the code 
			+ code.join("\n") + "\n"
			
			// and init the frontend components with whatever library you'd like
			+ `preactIslandClient({` + "\n"
				// (these variables are the references that we're importing above)
				+ variables.map(variable => `  ${variable}`).join(",\n") + "\n"
			+ '})'
	}
}

export default provider