
export function isKebabCase(target: unknown): target is string {
	const kebab = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
	if (typeof target !== 'string') return false
	return kebab.test(target)
}