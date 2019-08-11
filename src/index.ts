import { docopt } from 'docopt'
import chalk from 'chalk'

const help = `
Mark ${chalk.redBright('I')} Shell

Usage: mark [<file>] [<arg>...]
       mark -c <command> [<arg>...]
       mark --version
       mark (-h | --help)
`

const options = docopt(help, { version: '1' })

if (options['-c']) {
  console.log('command')
} else if (options['<file>']) {
  console.log('file')
} 

if (process.stdin.isTTY && process.stdin.setRawMode) {
  process.stdin.setRawMode(true)
}

process.stdin.on('data', (data: Buffer) => {
  if (data[0] === 3) process.exit(0)
  console.log(data)
})
