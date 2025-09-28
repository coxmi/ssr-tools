```
Note: this is a work in progress
```

# ssr-tools

Some tools to use in SSR-rendered apps, designed primarily around islands, vite, and a next-style file router.




### Using vite:

```js
import preact from '@preact/preset-vite'
import { islands, fileRouter, client } from 'ssr-tools'

defineConfig({
   plugins: [
      preact(),
      islands(),
      fileRouter(),
      client(),
   ],
   build: {
      ssr: true 
   }
})
```

## Plugins

### `islands()`

Import components as islands with a simple import:

```ts
import { ComplexComponent } from './button.ts?island'

// props are automatically serialised and a client-side bundle is 
// added to the manifest, with only the used island components
<ComplexComponent name={'my-component'} />
```

By default this works with Preact only, but the provider interface is simple enough that you can build one yourself for other frameworks ([see Preact example](https://github.com/coxmi/ssr-tools/tree/main/src/islands/providers/preact)). Just pass in your provider in your `vite.config.ts`:

```ts
islands({
   provider: {
     ssr: {
       name: 'name-of-export',
       importFrom: 'path/that/resolves/to/ssr/wrapper'
       importNamed: true | false
     },
     bundle: ({ imports, variables, code }) => `
       // client bundle content goes here
     `
   }
})
```


### `client()`

Import anything directly into the client bundle:

```ts
import from './client.ts?client'

// props are automatically serialised and a client-side bundle is 
// added to the manifest, with only the used island components
<ComplexComponent name={'my-component'} />
```

### `fileRouter()`

A Next-style file router. To start, add the plugin and define a route:

`vite.config.ts`

```ts
defineConfig({
   plugins: [
      fileRouter({
      	  // default options
         dir: 'src/pages'
         glob: '**/*.{ts,tsx,js,jsx}'
         removeTrailingSlash: true
      }),
   ],
   build: {
      ssr: true 
   }
})

```

`src/pages/[slug].tsx`

```ts

export default function page(ctx) {
	return `<html>
		<body>
			<h1>${ctx.params.slug}</h1>
		</body>
	</html>`
}
```

Then add the file router middleware to your server:

```ts
import http from 'node:http'
import { fileRouterMiddleware } from 'ssr-tools'

const fileRouter = await fileRouterMiddleware()
const app = http.createServer((req, res) => {
	fileRouter(req, res, () => res.end())
})
app.listen(port)	
	
```


#### Supported filename patterns:

| File name | Route pattern | Matching paths |
| :-- | :-- | :-- |
| `/index.ts` | `/`| `/` |
| `/about.ts` | `/about`| `/about` |
| `/books/[slug].ts` | `/books/:slug`| `/books/foo`<br> `/books/bar` |
| `/books/[slug]/reviews` | `/blog/:slug/reviews`| `/blog/foo/reviews`|
| `/api/[...all].ts` | `/api/*all`| `/api/search`<br> `/api/docs/foo`<br> `/api/docs/bar`|


#### `ctx` 

Context is an object passed to each route handler, with the following properties:

| Property | Description | Example/usage |
| :-- | :-- | :-- |
| `params` | Any route params from request | `{ slug: 'hello-world' }` |
| `path` | The relative path to the requested page | `/blog/hello-world` |
| `query` | [`URLSearchParams`](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams) object | `query.get('category')` |

#### Static rendering

To render static pages, Export a `build` object to your route:

`src/pages/[slug].tsx`

```ts

export default build = {
	// return an iterable, and a page will
	// be generated for each entry
   from: await getPages()
   
   // specify your url params
   // props is each entry from `from`
   url: props => {
      slug: slugify(props.title)
   }
}

// render the content from `ctx.props`
export default function page(ctx) {
	return `<html>
		<body>
			<h1>${ctx.props.title}</h1>
		</body>
	</html>`
}
```

### Still to complete

- Custom handlers for `GET`/`HEAD`/`POST`/`PUT`/`DELETE`/`OPTIONS`/`PATCH`
- Web-standard `Request`/`Response` arguments in all middleware and route handlers
- `FormData` handling
- Set props for single pages in `build.props`
- Route path override for custom routes
- Render statically-generated pages from middleware
- Ability to render routes outside of Vite
- Multi-platform support
- And more…



# Contributing

Contributions welcome!


# Acknowledgements 
Adapted from [vite-plugin-voie](https://github.com/brattonross/vite-plugin-voie), and [barelyhuman](https://github.com/barelyhuman)'s [preact-island-plugins](https://github.com/barelyhuman/preact-island-plugins).