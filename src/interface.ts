import { ReadStream, WriteStream } from 'tty'
import { Readable } from 'stream'
import { SSL_OP_LEGACY_SERVER_CONNECT } from 'constants';
import { Interpreter } from './interpreter';

class TeletypeInterface {
  private line = Buffer.alloc(8)
  private lineLength = 0
  private cursor = 0

  private registerInputHandler(stdin: ReadStream) {
    stdin.once('data', data => this.onInput(data, 0)
        .catch(err => console.log)
        .then(() => this.registerInputHandler))
  }

  constructor(stdin: ReadStream, private interpreter: Interpreter) {
    this.registerInputHandler(stdin)
  }

  private appendToLine(buffer: Buffer, offset: number) {
    let line = this.line
    if (this.lineLength === this.line.length) {
      this.line = Buffer.alloc(line.length * 2)
      line.copy(this.line)
    }
    buffer.copy(this.line, this.lineLength, offset, 1)
    this.lineLength += 1
    this.cursor
  }

  private async onInput(data: Buffer, offset: number) {
    if (data[offset] === 8) {
      this.lineLength--
      this.cursor--
      await this.onInput(data, offset + 1)
    } else if (data[offset] === 9) {
      this.appendToLine(data, offset)
      await this.onInput(data, offset + 1)
    } else if (data[offset] === 10) {
      await this.interpreter.run(this.line.toString('utf8', 0, this.lineLength), '<stdin>')
      this.line = Buffer.alloc(8)
      this.lineLength = 0
      this.cursor = 0
      await this.onInput(data, offset + 1)
    } else if (data[offset] === 11) {
      this.appendToLine(data, offset)
      await this.onInput(data, offset + 1)
    } else if (data[offset] === 127) {
      this.line.copyWithin(this.cursor, this.cursor + 1, this.lineLength)
      await this.onInput(data, offset + 1)
    }
  }

  protected onLine(line: string) {

  }
}

if (process.stdin.isTTY) {
  (process.stdin as ReadStream).setRawMode(true)
}

process.stdin.on('data', (data: Buffer) => {
  console.log(data + ' \'' + data.toString('utf8') + '\'')
})
