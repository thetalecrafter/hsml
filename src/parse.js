"use strict"
const acorn = require("acorn")
const { tokContexts: tc, tokTypes: tt } = acorn

tt.hsmlSelfClose = new acorn.TokenType("/>", { beforeExpr: true })
tt.hsmlEndTag = new acorn.TokenType(">", { beforeExpr: true })
tc.hsmlAttribute = new acorn.TokContext("hsmlAttribute")

acorn.plugins.hsml = function(instance, opts) {
  if (!opts) return

  instance.options.plugins.hsml = {}

  instance.extend("readToken", function(inner) {
    return function(code) {
      if (this.curContext() === tc.hsmlAttribute) {
        if (code === 47 && this.input.charCodeAt(this.pos + 1) === 62) {
          this.pos += 2
          return this.finishToken(tt.hsmlSelfClose)
        }
        if (code === 62) {
          this.pos += 1
          return this.finishToken(tt.hsmlEndTag)
        }
      }
      return inner.call(this, code)
    }
  })
}

const VOIDS = "area base br col embed hr img input keygen link meta param source track wbr".split(
  " "
)
const CDATAS = "script style".split(" ")

exports.parse = function parse(input, options) {
  return new exports.Parser(input, options).parse()
}

exports.Parser = class Parser {
  constructor(input, options) {
    this.offset = 0
    this.line = 1
    this.column = 0
    this.input = input
    this.options = { ...options }
    this.isDoctypeAllowed = true
  }

  advance(count = 1) {
    if (this.offset + count > this.input.length) {
      throw new Error("Unexpected end of file")
    }
    while (count > 0) {
      count -= 1
      if (this.input[this.offset] === "\n") {
        this.line += 1
        this.column = 0
      } else {
        this.column += 1
      }
      this.offset += 1
    }
  }

  eat(expected) {
    const length = expected.length
    if (this.input.slice(this.offset, this.offset + length) !== expected) {
      return false
    }
    this.advance(length)
    return true
  }

  expect(expected) {
    const length = expected.length
    if (this.input.slice(this.offset, this.offset + length) !== expected) {
      throw new Error(`Expected '${expected}'`)
    }
    this.advance(length)
  }

  isValidNameChar(char) {
    return (
      (char >= "A" && char <= "Z") ||
      (char >= "a" && char <= "z") ||
      char === "-" ||
      char === "_" ||
      char === "$"
    )
  }

  isWhitespace(char) {
    const code = char && char.charCodeAt(0)
    return (
      (code >= 0x09 && code <= 0x0d) ||
      code === 0x20 ||
      code === 0x85 ||
      code === 0xa0 ||
      code === 0x180e ||
      (code >= 0x2000 && code <= 0x200d) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x2060 ||
      code === 0x3000 ||
      code === 0xfeff
    )
  }

  skipWhitespace() {
    while (this.isWhitespace(this.input[this.offset])) this.advance()
    return true
  }

  getPosition() {
    return { line: this.line, column: this.column }
  }

  parseWhitespace() {
    const start = this.offset
    this.skipWhitespace()
    return this.offset > start
  }

  parseList(parse, delimit) {
    const list = []
    let node
    while ((node = parse.call(this))) {
      list.push(node)
      if (delimit && !delimit.call(this)) break
    }
    return list
  }

  parse() {
    const start = this.getPosition()
    this.skipWhitespace()
    const body = this.parseList(this.parseTopElement, this.skipWhitespace)
    this.skipWhitespace()
    const end = this.getPosition()
    return {
      type: "HSMLDocument",
      loc: { start, end },
      body
    }
  }

  parseTopElement() {
    return (
      this.parseDoctype() ||
      this.parseComment() ||
      this.parseElement() ||
      this.parsePlaceholder() ||
      this.parseText()
    )
  }

  parseDoctype() {
    if (
      !this.isDoctypeAllowed ||
      this.input.slice(this.offset, this.offset + 9).toLowerCase() !==
        "<!doctype"
    )
      return
    const s = this.offset
    const start = this.getPosition()
    this.advance(2)
    const tagName = this.parseName()
    this.skipWhitespace()
    const name = this.parseName()
    this.skipWhitespace()
    while (this.input[this.offset] !== ">") this.advance()
    if (
      this.input[this.offset] !== ">" ||
      tagName.toLowerCase() !== "doctype" ||
      !name
    ) {
      throw new Error("Invalid doctype")
    }
    this.advance()
    this.isDoctypeAllowed = false
    return {
      type: "HSMLDoctype",
      loc: { start, end: this.getPosition() },
      name,
      raw: this.input.slice(s, this.offset)
    }
  }

  parseComment() {
    const start = this.getPosition()
    if (!this.eat("<!--")) return
    const s = this.offset
    while (this.input.slice(this.offset, this.offset + 3) !== "-->") {
      this.advance()
    }
    const e = this.offset
    this.expect("-->")
    return {
      type: "HSMLComment",
      loc: { start, end: this.getPosition() },
      data: this.input.slice(s, e)
    }
  }

  parseElement() {
    const start = this.getPosition()
    if (!this.eat("<")) return
    const tagName = this.parseName()
    this.skipWhitespace()
    const attributes = this.parseList(this.parseAttribute, this.parseWhitespace)
    this.skipWhitespace()
    let children = null
    if (!this.eat("/>")) {
      this.expect(">")
      if (CDATAS.includes(tagName.toLowerCase())) {
        children = this.parseImplicitCData(tagName)
        this.expect(`</${tagName}>`)
      } else if (!VOIDS.includes(tagName.toLowerCase())) {
        this.skipWhitespace()
        children = this.parseList(this.parseChild, this.skipWhitespace)
        this.skipWhitespace()
        this.expect(`</${tagName}>`)
      }
    }
    this.isDoctypeAllowed = false
    return {
      type: "HSMLElement",
      loc: { start, end: this.getPosition() },
      tagName,
      attributes,
      children
    }
  }

  parseName() {
    const start = this.offset
    while (this.isValidNameChar(this.input[this.offset])) this.advance()
    return this.input.slice(start, this.offset)
  }

  parseAttribute() {
    const start = this.getPosition()
    const name = this.parseName()
    if (!name) return
    const { offset, line, column } = this
    this.skipWhitespace()
    let value = { type: "Literal", value: true }
    if (this.eat("=")) {
      this.skipWhitespace()
      value = this.parseValue()
    } else {
      this.offset = offset
      this.line = line
      this.column = column
    }
    return {
      type: "HSMLAttribute",
      loc: { start, end: this.getPosition() },
      name,
      value
    }
  }

  parseValue() {
    const parser = new acorn.Parser(
      {
        ecmaVersion: 2017,
        sourceType: "module",
        locations: true,
        plugins: { hsml: true }
      },
      this.input,
      this.offset
    )
    parser.context.push(tc.hsmlAttribute)
    parser.nextToken()
    const value = parser.parseExpression()
    let advanceTo = parser.start
    // Whitespace between attributes is required, so don't skip all of it.
    if (this.isWhitespace(this.input[advanceTo - 1])) advanceTo -= 1
    this.advance(advanceTo - this.offset)
    return value
  }

  parseChild() {
    if (this.input.slice(this.offset, this.offset + 2) === "</") return
    return (
      this.parseComment() ||
      this.parseElement() ||
      this.parsePlaceholder() ||
      this.parseText()
    )
  }

  parseImplicitCData(tagName) {
    const start = this.getPosition()
    const s = this.offset
    let e = this.input.indexOf(`</${tagName}>`, s)
    if (e < 0) e = this.input.length
    if (s === e) return []
    this.advance(e - s)
    return [
      {
        type: "Literal",
        loc: { start, end: this.getPosition() },
        value: this.input.slice(s, this.offset)
      }
    ]
  }

  parsePlaceholder() {
    if (!this.eat("${")) return
    const parser = new acorn.Parser(
      {
        ecmaVersion: 2017,
        sourceType: "module",
        locations: true,
        plugins: { hsml: false }
      },
      this.input,
      this.offset
    )
    parser.nextToken()
    const expression = parser.parseExpression()
    this.advance(parser.start - this.offset)
    this.expect("}")
    return expression
  }

  parseText() {
    const start = this.getPosition()
    const s = this.offset
    while (
      this.offset < this.input.length &&
      this.input[this.offset] !== "<" &&
      this.input[this.offset] !== "\n" &&
      this.input.slice(this.offset, this.offset + 2) !== "${"
    ) {
      this.advance()
    }
    if (s === this.offset) return
    this.isDoctypeAllowed = false
    return {
      type: "Literal",
      loc: { start, end: this.getPosition() },
      value: this.input.slice(s, this.offset)
    }
  }
}
