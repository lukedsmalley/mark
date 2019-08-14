import { ReadStream, WriteStream } from 'tty'
import { StringDecoder } from 'string_decoder'
import { emitKeypressEvents, Key, Interface } from 'readline'
import { EventEmitter } from 'events'
import { promisify } from 'util';

const { inspect } = require('internal/util/inspect');
const {
  CSI,
  emitKeys,
  getStringWidth,
  isFullWidthCodePoint,
  kUTF16SurrogateThreshold,
  stripVTControlCharacters
} = require('internal/readline/utils');

const {
  kEscape,
  kClearToBeginning,
  kClearToEnd,
  kClearLine,
  kClearScreenDown
} = CSI;

const kHistorySize = 30;
const kMincrlfDelay = 100;
// \r\n, \n, or \r followed by something other than \n
const lineEnding = /\r?\n|\r(?!\n)/;

const kLineObjectStream = Symbol('line object stream');

const KEYPRESS_DECODER = Symbol('keypress-decoder');
const ESCAPE_DECODER = Symbol('escape-decoder');

// GNU readline library - keyseq-timeout is 500ms (default)
const ESCAPE_CODE_TIMEOUT = 500;


class TTYInterface extends EventEmitter {
  _sawKeyPress = false
  isCompletionEnabled: boolean = true

  private closed = false
  private paused = false

  private lineBuffer = ''
  private line = ''
  private cursor = 0
  private promptText = '> '
  private decoder = new StringDecoder('utf8')
  private sawReturnAt = 0
  private sawKeyPress = false
  private previousKey = null
  private lineObjectStream = null
  private history: string[] = []
  private historyIndex = -1
  private ttyWriter = this.normalTTYWriter
  private prevRows = 0

  constructor(private input: ReadStream, private output: WriteStream, private completer: Function) {
    super()
    
    if (process.env.TERM === 'dumb') {
      this.ttyWriter = this.dumbTTYWriter;
    }

    emitKeypressEvents(input, this as unknown as Interface)

    input.on('keypress', this.inputKeyPressHandler)
    input.on('end', this.inputTermEndHandler)

    input.setRawMode(true)
    output.on('resize', this.outputResizeHandler)
    this.once('close', this.closeHandler)
    input.resume()
  }

  private writeToOutput(buffer: string | Buffer) {
    this.output.write() //Need to promisify
  }

  private inputEndHandler = () => {
    if (this.lineBuffer.length > 0) {
      this.emit('line', this.lineBuffer)
    }
    this.close()
  }

  private inputTermEndHandler = () => {
    if (this.line.length > 0) {
      this.emit('line', this.line)
    }
    this.close()
  }

  private inputKeyPressHandler = (sequence: string, key: Key) => {
    this.ttyWriter(sequence, key)
    if (key.sequence) {
      // If the key.sequence is half of a surrogate pair
      // (>= 0xd800 and <= 0xdfff), refresh the line so
      // the character is displayed appropriately.
      const codePoint = key.sequence.codePointAt(0)
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        this.refreshLine();
      }
    }
  }

  private outputResizeHandler = () => {
    this.refreshLine()
  }
  
  private closeHandler = () => {
    this.input.removeListener('keypress', this.inputKeyPressHandler)
    this.input.removeListener('end', this.inputTermEndHandler)
    this.output.removeListener('resize', this.outputResizeHandler)
  }

  prompt(preserveCursor: boolean) {
    if (this.paused) {
      this.resume()
    }
    if (process.env.TERM !== 'dumb') {
      if (!preserveCursor) {
        this.cursor = 0
      }
      this.refreshLine()
    } else {
      this.output.write(this.promptText)
    }
  }

  question(query: string) {
    return new Promise((resolve, reject) => {
      if (this._questionCallback) {
        this.prompt()
      } else {
        this._oldPrompt = this._prompt;
        this.setPrompt(query);
        this._questionCallback = cb;
        this.prompt();
      }
    })
  }

  private lineHandler = (line) => {
    if (this._questionCallback) {
      var cb = this._questionCallback;
      this._questionCallback = null;
      this.setPrompt(this._oldPrompt);
      cb(line);
    } else {
      this.emit('line', line);
    }
  }

  private addHistory() {
    if (this.line.length === 0) return '';
  
    // If the history is disabled then return the line
    if (this.historySize === 0) return this.line;
  
    // If the trimmed line is empty then return the line
    if (this.line.trim().length === 0) return this.line;
  
    if (this.history.length === 0 || this.history[0] !== this.line) {
      if (this.removeHistoryDuplicates) {
        // Remove older history line if identical to new one
        const dupIndex = this.history.indexOf(this.line);
        if (dupIndex !== -1) this.history.splice(dupIndex, 1);
      }
  
      this.history.unshift(this.line);
  
      // Only store so many
      if (this.history.length > this.historySize) this.history.pop();
    }
  
    this.historyIndex = -1;
    return this.history[0];
  }

  private async refreshLine() {
    // line length
    const line = this.promptText + this.line
    const dispPos = this.getDisplayPos(line)
    const lineCols = dispPos.cols
    const lineRows = dispPos.rows
  
    // cursor position
    const cursorPos = this.getCursorPos()
  
    // First move to the bottom of the current line, based on cursor pos
    const prevRows = this.prevRows
    if (prevRows > 0) {
      await moveCursor(this.output, 0, -prevRows)
    }
  
    // Cursor to left edge.
    await cursorTo(this.output, 0);
    // erase data
    await clearScreenDown(this.output);
  
    // Write the prompt and the current buffer content.
    this.output.write(line);
  
    // Force terminal to allocate a new line
    if (lineCols === 0) {
      this._writeToOutput(' ');
    }
  
    // Move cursor to original position.
    cursorTo(this.output, cursorPos.cols);
  
    const diff = lineRows - cursorPos.rows;
    if (diff > 0) {
      moveCursor(this.output, 0, -diff);
    }
  
    this.prevRows = cursorPos.rows;
  }

  close() {
    if (this.closed) return;
    this.pause();
    if (this.terminal) {
      this._setRawMode(false);
    }
    this.closed = true;
    this.emit('close');
  }

  pause() {
    if (this.paused) return;
    this.input.pause();
    this.paused = true;
    this.emit('pause');
    return this;
  }

  resume() {
    if (!this.paused) return;
    this.input.resume();
    this.paused = false;
    this.emit('resume');
    return this;
  }

  write(d, key) {
    if (this.paused) this.resume();
    if (this.terminal) {
      this._ttyWrite(d, key);
    } else {
      this._normalWrite(d);
    }
  }

  private normalWrite(buffer: Buffer) {
    var string = this.decoder.write(b);
    if (this._sawReturnAt &&
        Date.now() - this._sawReturnAt <= this.crlfDelay) {
      string = string.replace(/^\n/, '');
      this._sawReturnAt = 0;
    }
  
    // Run test() on the new string chunk, not on the entire line buffer.
    const newPartContainsEnding = lineEnding.test(string);
  
    if (this._line_buffer) {
      string = this._line_buffer + string;
      this._line_buffer = null;
    }
    if (newPartContainsEnding) {
      this._sawReturnAt = string.endsWith('\r') ? Date.now() : 0;
  
      // Got one or more newlines; process into "line" events
      var lines = string.split(lineEnding);
      // Either '' or (conceivably) the unfinished portion of the next line
      string = lines.pop();
      this._line_buffer = string;
      for (var n = 0; n < lines.length; n++)
        this._onLine(lines[n]);
    } else if (string) {
      // No newlines this time, save what we have for next time
      this._line_buffer = string;
    }
  }

  private insertString(shim: string) {
    if (this.cursor < this.line.length) {
      var beg = this.line.slice(0, this.cursor);
      var end = this.line.slice(this.cursor, this.line.length);
      this.line = beg + shim + end;
      this.cursor += shim.length;
      this._refreshLine();
    } else {
      this.line += shim;
      this.cursor += shim.length;
  
      if (this._getCursorPos().cols === 0) {
        this._refreshLine();
      } else {
        this._writeToOutput(shim);
      }
  
      // A hack to get the line refreshed if it's needed
      this._moveCursor(0);
    }
  }

  private tabComplete(lastKeypressWasTab: boolean) {
    const self = this;
  
    self.pause();
    self.completer(self.line.slice(0, self.cursor), function onComplete(err, rv) {
      self.resume();
  
      if (err) {
        self._writeToOutput(`tab completion error ${inspect(err)}`);
        return;
      }
  
      const completions = rv[0];
      const completeOn = rv[1];  // The text that was completed
      if (completions && completions.length) {
        // Apply/show completions.
        if (lastKeypressWasTab) {
          self._writeToOutput('\r\n');
          var width = completions.reduce(function completionReducer(a, b) {
            return a.length > b.length ? a : b;
          }).length + 2;  // 2 space padding
          var maxColumns = Math.floor(self.columns / width);
          if (!maxColumns || maxColumns === Infinity) {
            maxColumns = 1;
          }
          var group = [];
          for (var i = 0; i < completions.length; i++) {
            var c = completions[i];
            if (c === '') {
              handleGroup(self, group, width, maxColumns);
              group = [];
            } else {
              group.push(c);
            }
          }
          handleGroup(self, group, width, maxColumns);
        }
  
        // If there is a common prefix to all matches, then apply that portion.
        var f = completions.filter((e) => e);
        var prefix = commonPrefix(f);
        if (prefix.length > completeOn.length) {
          self._insertString(prefix.slice(completeOn.length));
        }
  
        self._refreshLine();
      }
    });
  }

  private handleGroup(group, width, maxColumns) {
    if (group.length === 0) {
      return;
    }
    const minRows = Math.ceil(group.length / maxColumns);
    for (var row = 0; row < minRows; row++) {
      for (var col = 0; col < maxColumns; col++) {
        var idx = row * maxColumns + col;
        if (idx >= group.length) {
          break;
        }
        var item = group[idx];
        this._writeToOutput(item);
        if (col < maxColumns - 1) {
          for (var s = 0; s < width - item.length; s++) {
            self._writeToOutput(' ');
          }
        }
      }
      this._writeToOutput('\r\n');
    }
    this._writeToOutput('\r\n');
  }

  private wordLeft() {
    if (this.cursor > 0) {
      // Reverse the string and match a word near beginning
      // to avoid quadratic time complexity
      var leading = this.line.slice(0, this.cursor);
      var reversed = leading.split('').reverse().join('');
      var match = reversed.match(/^\s*(?:[^\w\s]+|\w+)?/);
      this._moveCursor(-match[0].length);
    }
  }

  private wordRight() {
    if (this.cursor < this.line.length) {
      var trailing = this.line.slice(this.cursor);
      var match = trailing.match(/^(?:\s+|[^\w\s]+|\w+)\s*/);
      this._moveCursor(match[0].length);
    }
  }

  private deleteLeft() {
    if (this.cursor > 0 && this.line.length > 0) {
      // The number of UTF-16 units comprising the character to the left
      const charSize = charLengthLeft(this.line, this.cursor);
      this.line = this.line.slice(0, this.cursor - charSize) +
                  this.line.slice(this.cursor, this.line.length);
  
      this.cursor -= charSize;
      this._refreshLine();
    }
  }

  private deleteRight() {
    if (this.cursor < this.line.length) {
      // The number of UTF-16 units comprising the character to the left
      const charSize = charLengthAt(this.line, this.cursor);
      this.line = this.line.slice(0, this.cursor) +
        this.line.slice(this.cursor + charSize, this.line.length);
      this._refreshLine();
    }
  }

  private deleteWordLeft() {
    if (this.cursor > 0) {
      // Reverse the string and match a word near beginning
      // to avoid quadratic time complexity
      var leading = this.line.slice(0, this.cursor);
      var reversed = leading.split('').reverse().join('');
      var match = reversed.match(/^\s*(?:[^\w\s]+|\w+)?/);
      leading = leading.slice(0, leading.length - match[0].length);
      this.line = leading + this.line.slice(this.cursor, this.line.length);
      this.cursor = leading.length;
      this._refreshLine();
    }
  }

  private deleteWordRight() {
    if (this.cursor < this.line.length) {
      var trailing = this.line.slice(this.cursor);
      var match = trailing.match(/^(?:\s+|\W+|\w+)\s*/);
      this.line = this.line.slice(0, this.cursor) +
                  trailing.slice(match[0].length);
      this._refreshLine();
    }
  }

  private deleteLineLeft() {
    this.line = this.line.slice(this.cursor);
    this.cursor = 0;
    this._refreshLine();
  }

  private deleteLineRight() {
    this.line = this.line.slice(0, this.cursor);
    this._refreshLine();
  }

  clearLine() {
    this._moveCursor(+Infinity);
    this._writeToOutput('\r\n');
    this.line = '';
    this.cursor = 0;
    this.prevRows = 0;
  }

  private line() {
    const line = this._addHistory();
    this.clearLine();
    this._onLine(line);
  }

  private historyNext() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.line = this.history[this.historyIndex];
      this.cursor = this.line.length; // Set cursor to end of line.
      this._refreshLine();
  
    } else if (this.historyIndex === 0) {
      this.historyIndex = -1;
      this.cursor = 0;
      this.line = '';
      this._refreshLine();
    }
  }

  private historyPrev() {
    if (this.historyIndex + 1 < this.history.length) {
      this.historyIndex++;
      this.line = this.history[this.historyIndex];
      this.cursor = this.line.length; // Set cursor to end of line.
  
      this._refreshLine();
    }
  }

  private getDisplayPos(s: string) {
    var offset = 0;
    const col = this.output.columns;
    var row = 0;
    var code;
    s = stripVTControlCharacters(s);
    for (var i = 0, len = s.length; i < len; i++) {
      code = s.codePointAt(i);
      if (code >= kUTF16SurrogateThreshold) { // Surrogates.
        i++;
      }
      if (code === 0x0a) { // new line \n
        // row must be incremented by 1 even if offset = 0 or col = +Infinity
        row += Math.ceil(offset / col) || 1;
        offset = 0;
        continue;
      }
      const width = getStringWidth(code);
      if (width === 0 || width === 1) {
        offset += width;
      } else { // width === 2
        if ((offset + 1) % col === 0) {
          offset++;
        }
        offset += 2;
      }
    }
    const cols = offset % col;
    const rows = row + (offset - cols) / col;
    return { cols: cols, rows: rows };
  }

  private getCursorPos() {
    const columns = this.columns;
    const strBeforeCursor = this._prompt + this.line.substring(0, this.cursor);
    const dispPos = this._getDisplayPos(
      stripVTControlCharacters(strBeforeCursor));
    var cols = dispPos.cols;
    var rows = dispPos.rows;
    // If the cursor is on a full-width character which steps over the line,
    // move the cursor to the beginning of the next line.
    if (cols + 1 === columns &&
        this.cursor < this.line.length &&
        isFullWidthCodePoint(this.line.codePointAt(this.cursor))) {
      rows++;
      cols = 0;
    }
    return { cols: cols, rows: rows };
  }

  private moveCursor = function(dx) {
    const oldcursor = this.cursor;
    const oldPos = this._getCursorPos();
    this.cursor += dx;
  
    // bounds check
    if (this.cursor < 0) this.cursor = 0;
    else if (this.cursor > this.line.length) this.cursor = this.line.length;
  
    const newPos = this._getCursorPos();
  
    // Check if cursors are in the same line
    if (oldPos.rows === newPos.rows) {
      var diffCursor = this.cursor - oldcursor;
      var diffWidth;
      if (diffCursor < 0) {
        diffWidth = -getStringWidth(
          this.line.substring(this.cursor, oldcursor)
        );
      } else if (diffCursor > 0) {
        diffWidth = getStringWidth(
          this.line.substring(this.cursor, oldcursor)
        );
      }
      moveCursor(this.output, diffWidth, 0);
      this.prevRows = newPos.rows;
    } else {
      this._refreshLine();
    }
  }

  private dumbTTYWriter = (s, key: Key) => {
    key = key || {};
  
    if (key.name === 'escape') return;
  
    if (this._sawReturnAt && key.name !== 'enter')
      this._sawReturnAt = 0;
  
    if (key.ctrl && key.name === 'c') {
      if (this.listenerCount('SIGINT') > 0) {
        this.emit('SIGINT');
      } else {
        // This readline instance is finished
        this.close();
      }
    }
  
    switch (key.name) {
      case 'return':  // Carriage return, i.e. \r
        this._sawReturnAt = Date.now();
        this._line();
        break;
  
      case 'enter':
        // When key interval > crlfDelay
        if (this._sawReturnAt === 0 ||
            Date.now() - this._sawReturnAt > this.crlfDelay) {
          this._line();
        }
        this._sawReturnAt = 0;
        break;
  
      default:
        if (typeof s === 'string' && s) {
          this.line += s;
          this.cursor += s.length;
          this._writeToOutput(s);
        }
    }
  }

  private normalTTYWriter = (sequence: string, key: Key) => {
    const previousKey = this._previousKey;
    key = key || {};
    this._previousKey = key;
  
    // Ignore escape key, fixes
    // https://github.com/nodejs/node-v0.x-archive/issues/2876.
    if (key.name === 'escape') return;
  
    if (key.ctrl && key.shift) {
      /* Control and shift pressed */
      switch (key.name) {
        case 'backspace':
          this._deleteLineLeft();
          break;
  
        case 'delete':
          this._deleteLineRight();
          break;
      }
  
    } else if (key.ctrl) {
      /* Control key pressed */
  
      switch (key.name) {
        case 'c':
          if (this.listenerCount('SIGINT') > 0) {
            this.emit('SIGINT');
          } else {
            // This readline instance is finished
            this.close();
          }
          break;
  
        case 'h': // delete left
          this._deleteLeft();
          break;
  
        case 'd': // delete right or EOF
          if (this.cursor === 0 && this.line.length === 0) {
            // This readline instance is finished
            this.close();
          } else if (this.cursor < this.line.length) {
            this._deleteRight();
          }
          break;
  
        case 'u': // Delete from current to start of line
          this._deleteLineLeft();
          break;
  
        case 'k': // Delete from current to end of line
          this._deleteLineRight();
          break;
  
        case 'a': // Go to the start of the line
          this._moveCursor(-Infinity);
          break;
  
        case 'e': // Go to the end of the line
          this._moveCursor(+Infinity);
          break;
  
        case 'b': // back one character
          this._moveCursor(-charLengthLeft(this.line, this.cursor));
          break;
  
        case 'f': // Forward one character
          this._moveCursor(+charLengthAt(this.line, this.cursor));
          break;
  
        case 'l': // Clear the whole screen
          cursorTo(this.output, 0, 0);
          clearScreenDown(this.output);
          this._refreshLine();
          break;
  
        case 'n': // next history item
          this._historyNext();
          break;
  
        case 'p': // Previous history item
          this._historyPrev();
          break;
  
        case 'z':
          if (process.platform === 'win32') break;
          if (this.listenerCount('SIGTSTP') > 0) {
            this.emit('SIGTSTP');
          } else {
            process.once('SIGCONT', () => {
              // Don't raise events if stream has already been abandoned.
              if (!this.paused) {
                // Stream must be paused and resumed after SIGCONT to catch
                // SIGINT, SIGTSTP, and EOF.
                this.pause();
                this.emit('SIGCONT');
              }
              // Explicitly re-enable "raw mode" and move the cursor to
              // the correct position.
              // See https://github.com/joyent/node/issues/3295.
              this._setRawMode(true);
              this._refreshLine();
            });
            this._setRawMode(false);
            process.kill(process.pid, 'SIGTSTP');
          }
          break;
  
        case 'w': // Delete backwards to a word boundary
        case 'backspace':
          this._deleteWordLeft();
          break;
  
        case 'delete': // Delete forward to a word boundary
          this._deleteWordRight();
          break;
  
        case 'left':
          this._wordLeft();
          break;
  
        case 'right':
          this._wordRight();
          break;
      }
  
    } else if (key.meta) {
      /* Meta key pressed */
  
      switch (key.name) {
        case 'b': // backward word
          this._wordLeft();
          break;
  
        case 'f': // forward word
          this._wordRight();
          break;
  
        case 'd': // delete forward word
        case 'delete':
          this._deleteWordRight();
          break;
  
        case 'backspace': // Delete backwards to a word boundary
          this._deleteWordLeft();
          break;
      }
  
    } else {
      /* No modifier keys used */
  
      // \r bookkeeping is only relevant if a \n comes right after.
      if (this._sawReturnAt && key.name !== 'enter')
        this._sawReturnAt = 0;
  
      switch (key.name) {
        case 'return':  // Carriage return, i.e. \r
          this._sawReturnAt = Date.now();
          this._line();
          break;
  
        case 'enter':
          // When key interval > crlfDelay
          if (this._sawReturnAt === 0 ||
              Date.now() - this._sawReturnAt > this.crlfDelay) {
            this._line();
          }
          this._sawReturnAt = 0;
          break;
  
        case 'backspace':
          this._deleteLeft();
          break;
  
        case 'delete':
          this._deleteRight();
          break;
  
        case 'left':
          // Obtain the code point to the left
          this._moveCursor(-charLengthLeft(this.line, this.cursor));
          break;
  
        case 'right':
          this._moveCursor(+charLengthAt(this.line, this.cursor));
          break;
  
        case 'home':
          this._moveCursor(-Infinity);
          break;
  
        case 'end':
          this._moveCursor(+Infinity);
          break;
  
        case 'up':
          this._historyPrev();
          break;
  
        case 'down':
          this._historyNext();
          break;
  
        case 'tab':
          // If tab completion enabled, do that...
          if (typeof this.completer === 'function' && this.isCompletionEnabled) {
            const lastKeypressWasTab = previousKey && previousKey.name === 'tab';
            this._tabComplete(lastKeypressWasTab);
            break;
          }
          // falls through
  
        default:
          if (typeof s === 'string' && s) {
            var lines = s.split(/\r\n|\n|\r/);
            for (var i = 0, len = lines.length; i < len; i++) {
              if (i > 0) {
                this._line();
              }
              this._insertString(lines[i]);
            }
          }
      }
    }
  }
}

function commonPrefix(strings) {
  if (!strings || strings.length === 0) {
    return '';
  }
  if (strings.length === 1) return strings[0];
  const sorted = strings.slice().sort();
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  for (var i = 0, len = min.length; i < len; i++) {
    if (min[i] !== max[i]) {
      return min.slice(0, i);
    }
  }
  return min;
}

function charLengthLeft(str, i) {
  if (i <= 0)
    return 0;
  if (i > 1 && str.codePointAt(i - 2) >= kUTF16SurrogateThreshold ||
      str.codePointAt(i - 1) >= kUTF16SurrogateThreshold) {
    return 2;
  }
  return 1;
}

function charLengthAt(str, i) {
  if (str.length <= i)
    return 0;
  return str.codePointAt(i) >= kUTF16SurrogateThreshold ? 2 : 1;
}

/**
 * moves the cursor to the x and y coordinate on the given stream
 */

function cursorTo(stream: WriteStream, x: number, y?: number) {
  const data = typeof y !== 'number' ? CSI`${x + 1}G` : CSI`${y + 1};${x + 1}H`
  return promisify(stream.write.bind(stream))(data)
}

/**
 * moves the cursor relative to its current location
 */

function moveCursor(stream: WriteStream, dx: number, dy: number) {
  let data = ''

  if (dx < 0) {
    data += CSI`${-dx}D`
  } else if (dx > 0) {
    data += CSI`${dx}C`
  }

  if (dy < 0) {
    data += CSI`${-dy}A`
  } else if (dy > 0) {
    data += CSI`${dy}B`
  }

  return promisify(stream.write.bind(stream))(data)
}

/**
 * clears the current line the cursor is on:
 *   -1 for left of the cursor
 *   +1 for right of the cursor
 *    0 for the entire line
 */

function clearLine(stream: WriteStream, direction: number) {
  const type = direction < 0 ? kClearToBeginning : direction > 0 ? kClearToEnd : kClearLine;
  return promisify(stream.write.bind(stream))(type)
}

/**
 * clears the screen from the current position of the cursor down
 */

function clearScreenDown(stream: WriteStream) {
  return promisify(stream.write.bind(stream))(kClearScreenDown)
}
