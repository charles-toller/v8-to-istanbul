module.exports = class CovFunction {
  constructor (name, startLine, startCol, endLine, endCol, count, absoluteStartCol, absoluteEndCol) {
    this.name = name
    this.startLine = startLine
    this.startCol = startCol
    this.endLine = endLine
    this.endCol = endCol
    this.count = count
    this.absoluteStartCol = absoluteStartCol
    this.absoluteEndCol = absoluteEndCol
  }

  toIstanbul () {
    const loc = {
      start: {
        line: this.startLine,
        column: this.startCol
      },
      end: {
        line: this.endLine,
        column: this.endCol
      }
    }
    return {
      name: this.name,
      decl: loc,
      loc: loc,
      line: this.startLine
    }
  }
}
