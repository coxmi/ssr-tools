```
Note: this is a work in progress
```

# ssr-tools

Some tools to use in SSR-rendered apps, designed primarily around preact islands, vite, and a next-style file router.


### Using vite:

```js
import preact from '@preact/preset-vite'
import { islands } from 'ssr-tools/islands/vite'

defineConfig({
    plugins: [
        preact(),
        islands()
    ],
    build: {
    	ssr: true 
	}
})
```

# Acknowledgements 
Adapted from [vite-plugin-voie](https://github.com/brattonross/vite-plugin-voie), and [barelyhuman](https://github.com/barelyhuman)'s [preact-island-plugins](https://github.com/barelyhuman/preact-island-plugins).