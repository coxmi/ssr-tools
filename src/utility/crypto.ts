import { createHash } from 'node:crypto'

console.log('———')
console.log(md5('test'))
console.log(md5('test'))
console.log('———')

export function md5(string: string) {
	const hash = createHash('md5')
	hash.update(string)
	return hash.digest('hex')
}