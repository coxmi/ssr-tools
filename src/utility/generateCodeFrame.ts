import fs from 'node:fs'
import { styleText } from 'node:util'

export const splitRE = /\r?\n/g
const fileMatchRE = /file:\/\/([^:]+):(\d+):(\d+)/g
const pathMatchRE = /\((\/[^:]+):(\d+):(\d+)\)/g

type Loc = (Pos & { file: string })

export function locFromStack(stack: string): Loc | false {
	const lines = stack.split(splitRE) || []
	for (const line of lines) {
		const file = fileMatchRE.exec(line)
		if (file) {
			return {
				file: file[1],
				line: Number(file[2]),
				column: Number(file[3])
			}
		}
		const path = pathMatchRE.exec(line)
		if (path) {
			return {
				file: path[1],
				line: Number(path[2]),
				column: Number(path[3])
			}
		}
	}
	return false
}

export function generateCodeFrameFromError(loc: Loc) {
	const source = fs.readFileSync(loc.file, 'utf8')
	if (!source) return ''
	return generateCodeFrame(source, loc)
}


// adapted from Vite's utils
// from https://github.com/vitejs/vite/blob/3a92bc79b306a01b8aaf37f80b2239eaf6e488e7/packages/vite/src/node/utils.ts#L504

const range: number = 2

export function pad(source: string, n = 2): string {
  const lines = source.split(splitRE)
  return lines.map((l) => ` `.repeat(n) + l).join(`\n`)
}

type Pos = {
  /** 1-based */
  line: number
  /** 0-based */
  column: number
}

function posToNumber(source: string, pos: number | Pos): number {
  if (typeof pos === 'number') return pos
  const lines = source.split(splitRE)
  const { line, column } = pos
  let start = 0
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    start += lines[i].length + 1
  }
  return start + column
}

function numberToPos(source: string, offset: number | Pos): Pos {
  if (typeof offset !== 'number') return offset
  if (offset > source.length) {
    throw new Error(
      `offset is longer than source length! offset ${offset} > length ${source.length}`,
    )
  }

  const lines = source.slice(0, offset).split(splitRE)
  return {
    line: lines.length,
    column: lines[lines.length - 1].length,
  }
}

const MAX_DISPLAY_LEN = 120
const ELLIPSIS = '...'

export function generateCodeFrame(
  source: string,
  start: number | Pos = 0,
  end?: number | Pos,
): string {
  start = Math.max(posToNumber(source, start), 0)
  end = Math.min(
    end !== undefined ? posToNumber(source, end) : start,
    source.length,
  )
  const lastPosLine =
    end !== undefined
      ? numberToPos(source, end).line
      : numberToPos(source, start).line + range
  const lineNumberWidth = Math.max(3, String(lastPosLine).length + 1)
  const lines = source.split(splitRE)
  let count = 0
  const res: string[] = []
  for (let i = 0; i < lines.length; i++) {
    count += lines[i].length
    if (count >= start) {
      for (let j = i - range; j <= i + range || end > count; j++) {
        if (j < 0 || j >= lines.length) continue
        const line = j + 1
        const lineLength = lines[j].length
        const pad = Math.max(start - (count - lineLength), 0)
        const underlineLength = Math.max(
          1,
          end > count ? lineLength - pad : end - start,
        )

        let displayLine = lines[j]
        let underlinePad = pad
        if (lineLength > MAX_DISPLAY_LEN) {
          let startIdx = 0
          if (j === i) {
            if (underlineLength > MAX_DISPLAY_LEN) {
              startIdx = pad
            } else {
              const center = pad + Math.floor(underlineLength / 2)
              startIdx = Math.max(0, center - Math.floor(MAX_DISPLAY_LEN / 2))
            }
            underlinePad =
              Math.max(0, pad - startIdx) + (startIdx > 0 ? ELLIPSIS.length : 0)
          }
          const prefix = startIdx > 0 ? ELLIPSIS : ''
          const suffix = lineLength - startIdx > MAX_DISPLAY_LEN ? ELLIPSIS : ''
          const sliceLen = MAX_DISPLAY_LEN - prefix.length - suffix.length
          displayLine =
            prefix + displayLine.slice(startIdx, startIdx + sliceLen) + suffix
        }

        const number = `${line}${' '.repeat(lineNumberWidth - String(line).length)}| `
        const code = displayLine.replaceAll('\t', '  ')
        res.push(
          '    '
          + styleText('dim', number)
          + code,
        )

        if (j === i) {
          // push underline
          const emptyMargin = `${' '.repeat(lineNumberWidth)}| `
          const underline = '^'.repeat(
            Math.min(underlineLength, MAX_DISPLAY_LEN),
          )
          res.push(
          	'    '
          	+ styleText('dim', emptyMargin)
            + ' '.repeat(underlinePad) 
            + styleText('green', underline),
          )
        } else if (j > i) {
          if (end > count) {
          	const number = `${' '.repeat(lineNumberWidth)}| `
            const length = Math.max(Math.min(end - count, lineLength), 1)
            const underline = '^'.repeat(Math.min(length, MAX_DISPLAY_LEN))
            res.push(
            	'    '
            	+ styleText('dim', number)
            	+ underline
            )
          }
          count += lineLength + 1
        }
      }
      break
    }
    count++
  }
  return res.join('\n')
}