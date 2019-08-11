import { ReadStream, WriteStream } from 'tty'
import { Readable } from 'stream'

function createInteractiveShell(input: Readable) {
  let lineBuffer = ''
  input.on('data', (data: Buffer) => {

  })
}

function createScriptShell(input: Readable) {
  let lineBuffer = ''
  input.on('data', (data: Buffer) => {
    
  })
}


class ScriptInterpreter {
  private lineBuffer: string = ''
  
  constructor(input: Readable) {
    input.on('data', this.onData.bind(this))
  }

  setLineEventHandler(handler: (line: string) => Promise<void>) {
    this.lineEventHandler = handler
  }

  private onData(data: Buffer) {
    if (data[0]data[0] >= 0x20 && data[0] <= 0x7E) {
      this.lineBuffer += data.toString('utf8')
    } else {
      this.lineEventHandler(this.lineBuffer)
        .catch(err => {
          //Depends on interactivity
          console.log(err)
        })
      this.lineBuffer = ''
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
