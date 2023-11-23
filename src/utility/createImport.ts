
type CreateImportOptions = {
	absPathToFile: string, 
	imports: Array<string>, 
	defaultName: string
}

export function createImport({ absPathToFile, imports = [], defaultName }: CreateImportOptions) {
	return imports.map(name => {
		if (name === 'default') {
			if (!defaultName) throw new Error('No defaultName provided to createImport options')
			return `export { default as ${defaultName} } from "${absPathToFile}"`
		} else {
			return `export { ${name} } from "${absPathToFile}"`
		}
	}).join("\n")
}