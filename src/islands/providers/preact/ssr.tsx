import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import type { ComponentConstructor, Context, JSX } from 'preact'

declare module "preact/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      "preact-island": {
      	children: JSX.Element
        'data-name': string,
        'data-props': string,
        'data-import': string,
      }
    }
  }
}

const isServer = typeof window === 'undefined'

let HydrationContext: Context<boolean>
if (isServer) {
	HydrationContext = createContext(false)
}

export const ssr = (Component: ComponentConstructor, name: string, importPath: string) => (props: any) => {

	const hasParentHydration = useContext(HydrationContext)
	if (hasParentHydration) return <Component {...props} /> 
	
	return <HydrationContext.Provider value={true}>
		<preact-island data-name={name} data-props={JSON.stringify(props)} data-import={importPath}>
			<Component {...props} />
		</preact-island>
	</HydrationContext.Provider>
}