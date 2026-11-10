export interface ServerSentEvent {
  event: string
  data: string
  id?: string
}

/** Incremental SSE frame parser. Feed decoded text chunks; frame boundaries may split anywhere. */
export class SSEParser {
  private buffer = ''
  private eventName = ''
  private data: string[] = []
  private id: string | undefined

  private readonly onEvent: (event: ServerSentEvent) => void

  constructor(onEvent: (event: ServerSentEvent) => void) {
    this.onEvent = onEvent
  }

  feed(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.search(/[\r\n]/)) >= 0) {
      const char = this.buffer[index]
      if (char === '\r' && index === this.buffer.length - 1) break
      const terminatorLength = char === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + terminatorLength)
      this.processLine(line)
    }
  }

  finish(): void {
    if (this.buffer) this.processLine(this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer)
    this.buffer = ''
    this.dispatch()
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatch()
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.eventName = value
    else if (field === 'data') this.data.push(value)
    else if (field === 'id' && !value.includes('\0')) this.id = value
  }

  private dispatch(): void {
    if (this.data.length) {
      this.onEvent({ event: this.eventName || 'message', data: this.data.join('\n'), ...(this.id ? { id: this.id } : {}) })
    }
    this.eventName = ''
    this.data = []
  }
}
