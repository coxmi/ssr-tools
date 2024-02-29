import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import type { ComponentConstructor, Context } from 'preact'

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