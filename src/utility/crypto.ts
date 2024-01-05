import { createHash } from 'node:crypto'

export function md5(string: string) {
	const hash = createHash('md5')
	hash.update(string)
	return hash.digest('hex')
}

export function sha(text: Buffer | string, length = 8): string {
  const h = createHash('sha256').update(text).digest('hex').substring(0, length)
  if (length <= 64) return h
  return h.padEnd(length, '_')
}