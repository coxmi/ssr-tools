
type Params = {
	params: Record<string, string | string[]>
}

type PromiseOr<T> = Promise<T> | T

type BuildShape<T = Params> = {
  from: () => PromiseOr<T>
  url: (props: T) => PromiseOr<string | Params>
}

/**
 * Helper funcion to define types on build exports
 *```ts
 * export const build = defineBuild({
 *	  async from() {
 *      return [{ title: 'My title', slug: 'page-slug' }]
 *	  },
 *	  url(props) {
 *      // props has full autocomplete
 *      return props.slug
 *    }
 *})
 *``` 
 */
function defineBuild<T>(build: BuildShape<T>): BuildShape<T> {
  return build
}

