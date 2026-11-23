// solve.js — a fast drop-in for csv-reader 1.0.0.
//
// run({text, header}) returns {columns, rows, errors} with exactly the
// reference reader's semantics:
//
// - A U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field that opens with a quote runs to the next quote that is not
//   doubled; "" inside it is one quote, and each CRLF or lone CR inside it
//   is read as LF. What follows the closing quote, up to the next comma or
//   line break, is appended as it stands (error quote_junk, when the field
//   ends). A quote that never closes is a literal character and the text
//   after it is read again as unquoted (error unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds
//   the records after it (every record when header is false), each padded
//   with empty strings (short_row, with fields: its field count) or cut
//   (long_row, with extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met; line is the 1-based
//   line its record starts on, counting every LF, CRLF and lone CR inside
//   quotes, and row is its record's index in rows, null for the header.
//
// Speed: records whose line holds no quote and no stray CR are split with
// the engine's native split; everything else goes through a single pass
// built on indexOf jumps, so no per-character loop touches clean data.

const QUOTE = 34; // "
const COMMA = 44; // ,
const CR = 13; // \r
const LF = 10; // \n
const BOM = 0xfeff;

export function run(input) {
  const s = input.text;
  const header = input.header;
  const n = s.length;
  let i = 0;
  if (n > 0 && s.charCodeAt(0) === BOM) i = 1;

  const errors = [];
  const records = [];
  let line = 1;
  let width = -1;

  // Record loop. recLine / recRow describe the record now being built (or
  // the next one, for errors met between records); they are refreshed at
  // the top of every iteration.
  while (true) {
    const recLine = line;
    const recRow = header ? (records.length === 0 ? null : records.length - 1) : records.length;
    if (i >= n) break;
    const c = s.charCodeAt(i);
    if (c === LF) {
      i++;
      line++;
      continue;
    }
    if (c === CR) {
      if (s.charCodeAt(i + 1) === LF) {
        i += 2;
        line++;
        continue;
      }
      errors.push({ code: "stray_cr", line: recLine, row: recRow });
      i++;
      continue;
    }

    // A real record starts here. Fast path: the line up to the next LF
    // holds no quote, so no quoted field can start or span it, and the
    // record ends at that LF.
    const lineEnd = s.indexOf("\n", i);
    if (lineEnd !== -1) {
      const seg = s.slice(i, lineEnd);
      const q = seg.indexOf('"');
      if (q === -1) {
        const r = seg.indexOf("\r");
        if (r === -1) {
          const fields = seg.split(",");
          i = lineEnd + 1;
          line++;
          pushRecord(records, fields, width, errors, recLine, recRow);
          if (width === -1) width = fields.length;
          continue;
        }
        if (r === seg.length - 1) {
          // Only CR is the CRLF ending the record.
          const fields = seg.slice(0, -1).split(",");
          i = lineEnd + 1;
          line++;
          pushRecord(records, fields, width, errors, recLine, recRow);
          if (width === -1) width = fields.length;
          continue;
        }
      }
    } else {
      // Last line, to end of text.
      const seg = s.slice(i);
      if (seg.indexOf('"') === -1 && seg.indexOf("\r") === -1) {
        const fields = seg.split(",");
        i = n;
        pushRecord(records, fields, width, errors, recLine, recRow);
        if (width === -1) width = fields.length;
        continue;
      }
    }

    // Slow path: this record holds quotes or stray CRs. One field at a
    // time, jumping with indexOf.
    const fields = [];
    let done = false;
    while (!done) {
      if (i >= n) {
        // After a comma, end of text means one last empty field.
        fields.push("");
        break;
      }
      if (s.charCodeAt(i) === QUOTE) {
        const close = closingQuote(s, i + 1, n);
        if (close === -1) {
          errors.push({ code: "unterminated_quote", line: recLine, row: recRow });
          // Fall through: the quote is literal, re-read as unquoted.
        } else {
          let value = s.slice(i + 1, close);
          if (value.indexOf('"') !== -1 || value.indexOf("\r") !== -1) {
            value = value.replace(/""/g, '"').replace(/\r\n?/g, "\n");
          }
          line += countBreaks(s, i + 1, close);
          // Junk after the closing quote, up to the next comma or break.
          let p = close + 1;
          let junk = "";
          let junkStart = p;
          let endKind = 0; // 0 = EOF, 1 = comma, 2 = line break
          while (true) {
            if (p >= n) {
              junk += s.slice(junkStart, p);
              endKind = 0;
              break;
            }
            const ch = s.charCodeAt(p);
            if (ch === COMMA) {
              junk += s.slice(junkStart, p);
              endKind = 1;
              break;
            }
            if (ch === LF) {
              junk += s.slice(junkStart, p);
              endKind = 2;
              break;
            }
            if (ch === CR) {
              if (s.charCodeAt(p + 1) === LF) {
                junk += s.slice(junkStart, p);
                endKind = 2;
                break;
              }
              errors.push({ code: "stray_cr", line: recLine, row: recRow });
              junk += s.slice(junkStart, p);
              p++;
              junkStart = p;
              continue;
            }
            p++;
          }
          if (junk.length > 0) {
            value += junk;
            errors.push({ code: "quote_junk", line: recLine, row: recRow });
          }
          fields.push(value);
          if (endKind === 1) {
            i = p + 1;
            continue;
          }
          if (endKind === 2) {
            i = s.charCodeAt(p) === CR ? p + 2 : p + 1;
            line++;
          } else {
            i = n;
          }
          done = true;
          break;
        }
      }
      // Unquoted field (also the re-read after an unterminated quote).
      let field = "";
      let segStart = i;
      let first = true;
      let retryQuoted = false;
      while (true) {
        let ci = s.indexOf(",", i);
        let ni = s.indexOf("\n", i);
        let ri = s.indexOf("\r", i);
        if (ci === -1) ci = Infinity;
        if (ni === -1) ni = Infinity;
        if (ri === -1) ri = Infinity;
        const m = ci < ni ? (ci < ri ? ci : ri) : (ni < ri ? ni : ri);
        if (m === Infinity) {
          field = first ? s.slice(segStart) : field + s.slice(segStart);
          fields.push(field);
          i = n;
          done = true;
          break;
        }
        if (m === ci) {
          field = first ? s.slice(segStart, m) : field + s.slice(segStart, m);
          fields.push(field);
          i = m + 1;
          break;
        }
        if (m === ni) {
          field = first ? s.slice(segStart, m) : field + s.slice(segStart, m);
          fields.push(field);
          i = m + 1;
          line++;
          done = true;
          break;
        }
        // m is a CR.
        if (s.charCodeAt(m + 1) === LF) {
          field = first ? s.slice(segStart, m) : field + s.slice(segStart, m);
          fields.push(field);
          i = m + 2;
          line++;
          done = true;
          break;
        }
        errors.push({ code: "stray_cr", line: recLine, row: recRow });
        field = first ? s.slice(segStart, m) : field + s.slice(segStart, m);
        first = false;
        i = m + 1;
        segStart = i;
        // Nothing but dropped CRs so far: the field still opens here, so
        // a quote at this point opens a quoted field.
        if (field === "" && s.charCodeAt(i) === QUOTE) {
          retryQuoted = true;
          break;
        }
      }
      if (retryQuoted) continue;
    }
    pushRecord(records, fields, width, errors, recLine, recRow);
    if (width === -1) width = fields.length;
  }

  const columns = header ? (records.length > 0 ? records[0] : null) : null;
  const rows = header ? records.slice(1) : records;
  return { columns, rows, errors };
}

// Find the index of the quote that closes a field opened at `open`
// (search starts at `from`), skipping "" escape pairs. -1 when the field
// never closes anywhere in the rest of the text.
function closingQuote(s, from, n) {
  let j = from;
  while (true) {
    const k = s.indexOf('"', j);
    if (k === -1 || k >= n) return -1;
    if (s.charCodeAt(k + 1) === QUOTE) {
      j = k + 2;
      continue;
    }
    return k;
  }
}

// Count line breaks inside s[a..b): every LF counts once, every CR counts
// once unless it is half of a CRLF.
function countBreaks(s, a, b) {
  let count = 0;
  let p = a;
  while (p < b) {
    const ni = s.indexOf("\n", p);
    const ri = s.indexOf("\r", p);
    if (ni === -1 && ri === -1) break;
    if (ri !== -1 && ri < b && (ni === -1 || ri < ni)) {
      count++;
      p = s.charCodeAt(ri + 1) === LF ? ri + 2 : ri + 1;
    } else if (ni !== -1 && ni < b) {
      count++;
      p = ni + 1;
    } else {
      break;
    }
  }
  return count;
}

// Append a finished record, padding or cutting it to the first record's
// width and reporting short_row / long_row when it ends. The first record
// sets the width and is never short or long.
function pushRecord(records, fields, width, errors, recLine, recRow) {
  if (width === -1) {
    records.push(fields);
    return;
  }
  if (fields.length < width) {
    errors.push({ code: "short_row", line: recLine, row: recRow, fields: fields.length });
    while (fields.length < width) fields.push("");
  } else if (fields.length > width) {
    const extra = fields.slice(width);
    errors.push({ code: "long_row", line: recLine, row: recRow, extra });
    fields.length = width;
  }
  records.push(fields);
}
