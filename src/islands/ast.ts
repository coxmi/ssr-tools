import { Parser } from 'acorn'
/* @ts-ignore */
import astringJSX from '@barelyhuman/astring-jsx'
import jsx from 'acorn-jsx'

/* @ts-ignore */
import { extend as jsxWalk } from 'acorn-jsx-walk'
import * as walk from 'acorn-walk'

import type { 
	Program, 
	Node,
	Expression,
    CallExpression,
    ExportNamedDeclaration,
    VariableDeclaration,
    VariableDeclarator,
    Literal
} from 'acorn'

jsxWalk(walk.base)

const jsxParser = Parser.extend(jsx())

export function astFromCode(code: string): Program {
  const ast = jsxParser.parse(code, {
    sourceType: 'module',
    ecmaVersion: 11,
  })
  return ast
}

export function codeFromAST(ast: Program) {
  return astringJSX.generate(ast)
}

export function addImportToAST(ast: Program, name: string, from: string, { named }: {named: boolean}) {
    for (let child of ast.body) {
      if (child.type !== 'ImportDeclaration') continue

      // Check if the node is a Literal (String/Number) and is the same value
      // as requested for import. If not, just continue to the next child
      if (!(child.source.type === 'Literal' && child.source.value === from))
        continue

      // Go through the imports to check if the import (either named or default)
      // exists already in the code
      // if yes, then do nothing.
      const hasExistingImport =
        child.specifiers.findIndex(x => {
          if (named) {
            return x.type === 'ImportSpecifier' && x.imported.name === name
          } else {
            return x.type === 'ImportDefaultSpecifier' && x.local.name === name
          }
        }) > -1

      if (hasExistingImport) {
        return
      }
    }

    const importAST = astFromCode(
      named
        ? `import { ${name} } from "${from}";`
        : `import ${name} from "${from}"`
    )

    ast.body.unshift(importAST.body[0])
}


export function walker(ast: Node, visitors: any) {
  return walk.simple(ast, visitors)
}


export function createNamedExportAST(localName: string, exportedName: string) {
	return {
		type: 'ExportNamedDeclaration',
		declaration: null,
		specifiers: [{
			type: 'ExportSpecifier',
			local: {
				type: 'Identifier',
				name: localName
			},
			exported: {
				type: 'Identifier',
				name: exportedName
			}
		}]
	} as ExportNamedDeclaration
}

export function createVariable(name: string, expression: Expression) {
	return {
		type: 'VariableDeclaration',
		declarations: [
			{
				type: 'VariableDeclarator',
				id: {
					type: 'Identifier',
				    name: name,
				},
				init: expression
			}  as VariableDeclarator
		],
		kind: 'const',
	}
}

export function createVariableFromVariableDeclarator(...declarators: VariableDeclarator[]) {
	return {
		type: 'VariableDeclaration',
		declarations: declarators,
		kind: 'const'
	} as VariableDeclaration
}

export function wrapWithCallExpression(name: string, astExpression: Expression, ...args: Array<Expression>) {
	return {
		type: 'CallExpression',
		callee: {
			type: 'Identifier',
			name: name
		},
		arguments: [astExpression, ...args],
		optional: false
	} as CallExpression
}

export function createStringLiteral(value: string) {
	return {
	    type: 'Literal',
	    value: value,
	    start: 0,
	    end: 0
	} as Literal
}
