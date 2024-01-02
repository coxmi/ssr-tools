import esbuild from 'esbuild'

let dev = process.argv[2] === '--dev'

const base = {
	entryPoints: [
		'src/file-router/index.ts',
		'src/islands/index.ts',
		'src/islands/vite.ts',
		'src/islands/providers/preact/index.ts',
		'src/islands/providers/preact/ssr.tsx',
		'src/islands/providers/preact/client.tsx',
	],
	outdir: 'dist',
	bundle: true,
	minify: false,
	sourcemap: true,
	platform: 'node',
  	packages: 'external',
}

const esm = {
	...base,
	format: 'esm',
  	outExtension: { '.js': '.mjs' },
}

if (dev) {
	const mjs = await esbuild.context(esm)
	await Promise.all([
		mjs.watch()
	])
} else {
	await esbuild.build(esm)
}