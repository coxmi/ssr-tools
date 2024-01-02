import { createHash } from 'node:crypto'

export function md5(string: string) {
	const hash = createHash('md5')
	hash.update(string)
	return hash.digest('hex')
}