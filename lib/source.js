const CovLine = require('./line')
const { GREATEST_LOWER_BOUND, LEAST_UPPER_BOUND } = require('source-map').SourceMapConsumer
const { parse } = require('@typescript-eslint/typescript-estree')
const { visitorKeys } = require('@typescript-eslint/visitor-keys')

function isValidNode (x) {
  return x !== null && typeof x === 'object' && typeof x.type === 'string'
}

function walkForComment (commentRange, node, prevSiblingRange) {
  if (!isValidNode(node)) {
    return false
  }
  if (node.type !== 'Program') {
    if (!prevSiblingRange && commentRange[1] < node.range[0]) {
      return node
    }
    if (prevSiblingRange && prevSiblingRange[1] < commentRange[0] && node.range[0] > commentRange[1]) {
      // Comment in between sibling and me, I am target
      return node
    }
    if (node.type !== 'Program' && (node.range[0] > commentRange[0] || node.range[1] < commentRange[1])) {
      return false
    }
  }
  let newPrevSiblingRange = null
  return (visitorKeys[node.type] == null ? [] : visitorKeys[node.type]).flatMap((key) => node[key]).map((a, i, arr) => {
    if (!isValidNode(a)) {
      return false
    }
    a.parent = [...(node.parent == null ? [] : node.parent), node]
    a.prevSibling = i === 0 ? { range: [...node.range].reverse() } : arr[i - 1]
    a.nextSibling = arr[i + 1] == null ? { range: [...node.range].reverse() } : arr[i + 1]
    const result = walkForComment(commentRange, a, newPrevSiblingRange)
    newPrevSiblingRange = a.range
    return result
  }).find((a) => a)
}

function getRangeForCommentType (type, range, ast) {
  const target = walkForComment(range, ast, null)
  switch (type) {
    case 'rest': {
      const parent = [...target.parent].reverse().find((a) => a.type === 'BlockStatement')
      return [target.prevSibling.range[1], parent.range[1]]
    }
    default:
      return [target.prevSibling.range[1], target.nextSibling.range[0]]
  }
}

module.exports = class CovSource {
  constructor (sourceRaw, wrapperLength, useParser) {
    sourceRaw = sourceRaw.trimEnd()
    this.lines = []
    this.eof = sourceRaw.length
    this.shebangLength = getShebangLength(sourceRaw)
    this.wrapperLength = wrapperLength - this.shebangLength
    this.ignoreSegments = []
    this._buildLines(sourceRaw)
    if (useParser === 'tsestree') {
      this._buildIgnoreSegments(sourceRaw)
    }
  }

  _buildIgnoreSegments (source) {
    const ast = parse(source, {
      comment: true,
      range: true
    })
    const commentReg = /^\s*t8 ignore ([^\s]*)/
    ast.comments.forEach((comment) => {
      if (commentReg.test(comment.value)) {
        const [, ignoreType] = commentReg.exec(comment.value)
        this.ignoreSegments.push(getRangeForCommentType(ignoreType, comment.range, ast))
      }
    })
    let i = 0
    while (i < this.ignoreSegments.length) {
      const char = source[this.ignoreSegments[i][1]]
      switch (char) {
        case '\n':
        case ';':
        case '}':
          this.ignoreSegments[i][1] += 1
          break
        default:
          i += 1
          break
      }
    }
  }

  _buildLines (source) {
    let position = 0
    let ignoreCount = 0
    for (const [i, lineStr] of source.split(/(?<=\r?\n)/u).entries()) {
      const line = new CovLine(i + 1, position, lineStr)
      if (ignoreCount > 0) {
        line.ignore = true
        ignoreCount--
      } else {
        ignoreCount = this._parseIgnoreNext(lineStr, line)
      }
      this.lines.push(line)
      position += lineStr.length
    }
  }

  _parseIgnoreNext (lineStr, line) {
    const testIgnoreNextLines = lineStr.match(/^\W*\/\* c8 ignore next (?<count>[0-9]+)? *\*\/\W*$/)
    if (testIgnoreNextLines) {
      line.ignore = true
      if (testIgnoreNextLines.groups.count) {
        return Number(testIgnoreNextLines.groups.count)
      } else {
        return 1
      }
    } else {
      if (lineStr.match(/\/\* c8 ignore next \*\//)) {
        line.ignore = true
      }
    }

    return 0
  }

  // given a start column and end column in absolute offsets within
  // a source file (0 - EOF), returns the relative line column positions.
  offsetToOriginalRelative (sourceMap, startCol, endCol) {
    const lines = this.lines.filter((line, i) => {
      return startCol <= line.endCol && endCol >= line.startCol
    })
    if (!lines.length) return {}

    const start = originalPositionTryBoth(
      sourceMap,
      lines[0].line,
      Math.max(0, startCol - lines[0].startCol)
    )
    let end = originalEndPositionFor(
      sourceMap,
      lines[lines.length - 1].line,
      endCol - lines[lines.length - 1].startCol
    )

    if (!(start && end)) {
      return {}
    }

    if (!(start.source && end.source)) {
      return {}
    }

    if (start.source !== end.source) {
      return {}
    }

    if (start.line === end.line && start.column === end.column) {
      end = sourceMap.originalPositionFor({
        line: lines[lines.length - 1].line,
        column: endCol - lines[lines.length - 1].startCol,
        bias: LEAST_UPPER_BOUND
      })
      end.column -= 1
    }

    return {
      startLine: start.line,
      relStartCol: start.column,
      endLine: end.line,
      relEndCol: end.column
    }
  }

  relativeToOffset (line, relCol) {
    line = Math.max(line, 1)
    if (this.lines[line - 1] === undefined) return this.eof
    return Math.min(this.lines[line - 1].startCol + relCol, this.lines[line - 1].endCol)
  }
}

// this implementation is pulled over from istanbul-lib-sourcemap:
// https://github.com/istanbuljs/istanbuljs/blob/master/packages/istanbul-lib-source-maps/lib/get-mapping.js
//
/**
 * AST ranges are inclusive for start positions and exclusive for end positions.
 * Source maps are also logically ranges over text, though interacting with
 * them is generally achieved by working with explicit positions.
 *
 * When finding the _end_ location of an AST item, the range behavior is
 * important because what we're asking for is the _end_ of whatever range
 * corresponds to the end location we seek.
 *
 * This boils down to the following steps, conceptually, though the source-map
 * library doesn't expose primitives to do this nicely:
 *
 * 1. Find the range on the generated file that ends at, or exclusively
 *    contains the end position of the AST node.
 * 2. Find the range on the original file that corresponds to
 *    that generated range.
 * 3. Find the _end_ location of that original range.
 */
function originalEndPositionFor (sourceMap, line, column) {
  // Given the generated location, find the original location of the mapping
  // that corresponds to a range on the generated file that overlaps the
  // generated file end location. Note however that this position on its
  // own is not useful because it is the position of the _start_ of the range
  // on the original file, and we want the _end_ of the range.
  const beforeEndMapping = originalPositionTryBoth(
    sourceMap,
    line,
    Math.max(column - 1, 1)
  )

  if (beforeEndMapping.source === null) {
    return null
  }

  // Convert that original position back to a generated one, with a bump
  // to the right, and a rightward bias. Since 'generatedPositionFor' searches
  // for mappings in the original-order sorted list, this will find the
  // mapping that corresponds to the one immediately after the
  // beforeEndMapping mapping.
  const afterEndMapping = sourceMap.generatedPositionFor({
    source: beforeEndMapping.source,
    line: beforeEndMapping.line,
    column: beforeEndMapping.column + 1,
    bias: LEAST_UPPER_BOUND
  })
  if (
  // If this is null, it means that we've hit the end of the file,
  // so we can use Infinity as the end column.
    afterEndMapping.line === null ||
      // If these don't match, it means that the call to
      // 'generatedPositionFor' didn't find any other original mappings on
      // the line we gave, so consider the binding to extend to infinity.
      sourceMap.originalPositionFor(afterEndMapping).line !==
          beforeEndMapping.line
  ) {
    return {
      source: beforeEndMapping.source,
      line: beforeEndMapping.line,
      column: Infinity
    }
  }

  // Convert the end mapping into the real original position.
  return sourceMap.originalPositionFor(afterEndMapping)
}

function originalPositionTryBoth (sourceMap, line, column) {
  const original = sourceMap.originalPositionFor({
    line,
    column,
    bias: GREATEST_LOWER_BOUND
  })
  if (original.line === null) {
    return sourceMap.originalPositionFor({
      line,
      column,
      bias: LEAST_UPPER_BOUND
    })
  } else {
    return original
  }
}

function getShebangLength (source) {
  if (source.indexOf('#!') === 0) {
    const match = source.match(/(?<shebang>#!.*)/)
    if (match) {
      return match.groups.shebang.length
    }
  } else {
    return 0
  }
}
