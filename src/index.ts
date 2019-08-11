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
} else {
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(true)
  }
}
