// CSVヘッダー変換の中核ロジック。ブラウザ（window.CsvConv）でもNode（require）でも使える。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CsvConv = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- CSVの読み書き -------------------------------------------------

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function toCSV(rows, opts) {
    const eol = (opts && opts.eol) || '\r\n';
    const quoteAll = !!(opts && opts.quoteAll);
    const esc = (v) => {
      v = String(v);
      return quoteAll || /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    return rows.map((r) => r.map(esc).join(',')).join(eol) + eol;
  }

  // ---- 文字コード ----------------------------------------------------

  // UTF-8として読めればUTF-8、読めなければShift-JIS（Windows-31J）とみなす。
  function decodeBytes(bytes) {
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
    } catch (e) {
      return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
    }
  }

  let sjisMap = null;
  // TextDecoderの復号結果を逆引きして、Shift-JISの符号化表を作る（外部ライブラリ不要）。
  function buildSjisMap() {
    const dec = new TextDecoder('shift_jis');
    const map = new Map();
    for (let b = 0x20; b <= 0x7e; b++) map.set(String.fromCharCode(b), [b]);
    for (let b = 0xa1; b <= 0xdf; b++) map.set(dec.decode(new Uint8Array([b])), [b]); // 半角カナ
    for (let hi = 0x81; hi <= 0xfc; hi++) {
      if (hi >= 0xa0 && hi <= 0xdf) continue;
      for (let lo = 0x40; lo <= 0xfc; lo++) {
        if (lo === 0x7f) continue;
        const ch = dec.decode(new Uint8Array([hi, lo]));
        if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [hi, lo]);
      }
    }
    map.set('\r', [0x0d]); map.set('\n', [0x0a]); map.set('\t', [0x09]);
    return map;
  }

  // 戻り値: { bytes, unmappable }。Shift-JISに無い文字は「?」にして unmappable に集める。
  function encodeShiftJIS(text) {
    if (!sjisMap) sjisMap = buildSjisMap();
    const out = [], unmappable = [];
    for (const ch of text) {
      const b = sjisMap.get(ch);
      if (b) out.push(...b);
      else { out.push(0x3f); if (!unmappable.includes(ch)) unmappable.push(ch); }
    }
    return { bytes: new Uint8Array(out), unmappable };
  }

  // ---- 変換 ----------------------------------------------------------
  // rules = { columns: [ { name, type, ... } ] }
  //   type 'source' : { from }                       元の列をそのまま
  //   type 'join'   : { from: [列名...], sep }       複数列を結合（空欄は飛ばす）
  //   type 'fixed'  : { value }                      全行に同じ値
  //   type 'seq'    : { start, pad, groupBy }        連番。groupByを指定するとその列の値ごとに数え直す
  //   type 'blank'  : {}                             空欄

  function convert(rows, rules) {
    const warnings = [];
    if (!rows.length) return { header: [], rows: [], warnings: ['入力が空です'] };
    const inHeader = rows[0].map((h) => h.trim());
    const idx = new Map();
    inHeader.forEach((h, i) => { if (!idx.has(h)) idx.set(h, i); });
    const data = rows.slice(1).filter((r) => r.some((v) => v.trim() !== ''));

    const missing = new Set();
    const col = (name, r) => {
      const i = idx.get(String(name).trim());
      if (i === undefined) { missing.add(name); return ''; }
      return r[i] === undefined ? '' : r[i];
    };

    const counters = rules.columns.map(() => new Map());
    const header = rules.columns.map((c) => c.name);
    const out = data.map((r) => rules.columns.map((c, ci) => {
      switch (c.type) {
        case 'source': return col(c.from, r);
        case 'join': return (c.from || []).map((n) => col(n, r)).filter((v) => v !== '').join(c.sep || '');
        case 'fixed': return c.value === undefined ? '' : String(c.value);
        case 'seq': {
          const key = c.groupBy ? col(c.groupBy, r) : '';
          const next = (counters[ci].get(key) || (Number(c.start) || 1) - 1) + 1;
          counters[ci].set(key, next);
          return String(next).padStart(Number(c.pad) || 0, '0');
        }
        default: return '';
      }
    }));
    for (const m of missing) warnings.push('入力に列「' + m + '」がありません（空欄で出力しました）');
    return { header, rows: out, warnings };
  }

  function validateRules(rules) {
    if (!rules || !Array.isArray(rules.columns) || !rules.columns.length) throw new Error('ルールに columns がありません');
    for (const c of rules.columns) {
      if (!c.name) throw new Error('出力列名が空の列があります');
      if (!['source', 'join', 'fixed', 'seq', 'blank'].includes(c.type)) throw new Error('列「' + c.name + '」の type が不正です: ' + c.type);
    }
    return rules;
  }

  return { parseCSV, toCSV, decodeBytes, encodeShiftJIS, convert, validateRules };
});
