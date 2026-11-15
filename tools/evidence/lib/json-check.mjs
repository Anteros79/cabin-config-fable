// Strict RFC 8259 validator that reports the first syntax error with its byte offset.
// It validates only; it never repairs or completes input.

export function validateJson(text) {
  let i = 0;
  const n = text.length;
  const fail = (message) => {
    const before = text.slice(0, i);
    const line = before.split('\n').length;
    const column = i - (before.lastIndexOf('\n') + 1) + 1;
    const err = new Error(message);
    err.info = {
      message,
      offset: i,
      line,
      column,
      found: i < n ? text[i] : '<end of input>',
      context: text.slice(Math.max(0, i - 30), Math.min(n, i + 30)),
    };
    throw err;
  };
  const ws = () => { while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
  const string = () => {
    i++;
    while (i < n) {
      const ch = text[i];
      if (ch === '"') { i++; return; }
      if (ch === '\\') {
        const e = text[i + 1];
        if ('"\\/bfnrt'.includes(e)) i += 2;
        else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) i += 6;
        else fail('invalid escape sequence in string');
      } else if (ch < ' ') fail('unescaped control character in string');
      else i++;
    }
    fail('unterminated string');
  };
  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (!m) fail('invalid number');
    i += m[0].length;
  };
  const value = () => {
    ws();
    if (i >= n) fail('unexpected end of input, expected a value');
    const ch = text[i];
    if (ch === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected string key in object');
        string(); ws();
        if (text[i] !== ':') fail("expected ':' after object key");
        i++;
        value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        fail("expected ',' or '}' in object");
      }
    }
    if (ch === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) {
        value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return; }
        fail("expected ',' or ']' in array");
      }
    }
    if (ch === '"') return string();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return number();
    for (const lit of ['true', 'false', 'null']) if (text.startsWith(lit, i)) { i += lit.length; return; }
    fail(`unexpected token ${JSON.stringify(ch)}, expected a JSON value`);
  };
  try {
    value();
    ws();
    if (i < n) fail('unexpected trailing content after the top-level value');
    return { valid: true, error: null };
  } catch (e) {
    if (e.info) return { valid: false, error: e.info };
    throw e;
  }
}
