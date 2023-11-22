import esbuild from 'esbuild'

let dev = process.argv[2] === '--dev'

const base = {
	entryPoints: [
		'src/file-router/index.ts',
		'src/islands/index.ts',
		'src/islands/vite.ts',
		'src/hydrate/preact.tsx',
	],
	outdir: 'dist',
	bundle: true,
	minify: false,
	sourcemap: true,
	platform: 'node',
  	packages: 'external',
}

const common = {
	...base,
  	outExtension: { '.js': '.cjs' },
}

const esm = {
	...base,
	format: 'esm',
  	outExtension: { '.js': '.mjs' },
}



if (dev) {
	const cjs = await esbuild.context(common)
	const mjs = await esbuild.context(esm)
	await Promise.all([
		cjs.watch(), 
		mjs.watch()
	])
} else {
	await esbuild.build(common)
	await esbuild.build(esm)
}