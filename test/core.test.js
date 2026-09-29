const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../core.js');

const ex = (f) => path.join(__dirname, '..', 'examples', f);

test('parseCSV: 引用符・カンマ・改行入りセル・CRLF', () => {
  const rows = C.parseCSV('a,b\r\n"x,1","line1\nline2"\r\n"q""q",\r\n');
  assert.deepStrictEqual(rows, [['a', 'b'], ['x,1', 'line1\nline2'], ['q"q', '']]);
});

test('toCSV → parseCSV で往復できる', () => {
  const rows = [['a', 'b'], ['x,1', 'l1\nl2'], ['q"q', '']];
  assert.deepStrictEqual(C.parseCSV(C.toCSV(rows)), rows);
});

test('Shift-JIS: 書き出し→読み込みで元に戻る（全角・半角カナ・記号）', () => {
  const s = '注文者,山田 太郎,ｶﾀｶﾅ,①,〒100-0001,～';
  const { bytes, unmappable } = C.encodeShiftJIS(s);
  assert.deepStrictEqual(unmappable, []);
  assert.strictEqual(new TextDecoder('shift_jis').decode(bytes), s);
});

test('Shift-JIS: 表現できない文字は?にして報告する', () => {
  const { bytes, unmappable } = C.encodeShiftJIS('a😀b');
  assert.deepStrictEqual(unmappable, ['😀']);
  assert.strictEqual(new TextDecoder().decode(bytes), 'a?b');
});

test('decodeBytes: UTF-8とShift-JISを自動判定', () => {
  const u = new TextEncoder().encode('伝票番号,受注日');
  assert.strictEqual(C.decodeBytes(u).encoding, 'utf-8');
  const sj = C.encodeShiftJIS('伝票番号,受注日').bytes;
  const d = C.decodeBytes(sj);
  assert.strictEqual(d.encoding, 'shift_jis');
  assert.strictEqual(d.text, '伝票番号,受注日');
});

test('convert: 列の付け替え・固定値・連番・結合・空欄', () => {
  const rows = C.parseCSV('id,name,a1,a2\nX1,太郎,東京,1-2\nX1,太郎,東京,1-2\nX2,花子,大阪,\n');
  const rules = { columns: [
    { name: '固定', type: 'fixed', value: 'N' },
    { name: '注文', type: 'source', from: 'id' },
    { name: '住所', type: 'join', from: ['a1', 'a2'], sep: ' ' },
    { name: '明細', type: 'seq', start: 1, pad: 4, groupBy: 'id' },
    { name: '通し', type: 'seq', start: 10 },
    { name: '空', type: 'blank' },
  ] };
  const r = C.convert(rows, rules);
  assert.deepStrictEqual(r.header, ['固定', '注文', '住所', '明細', '通し', '空']);
  assert.deepStrictEqual(r.rows, [
    ['N', 'X1', '東京 1-2', '0001', '10', ''],
    ['N', 'X1', '東京 1-2', '0002', '11', ''],
    ['N', 'X2', '大阪', '0001', '12', ''],
  ]);
  assert.deepStrictEqual(r.warnings, []);
});

test('convert: 存在しない元の列は警告して空欄、空行は無視', () => {
  const rows = C.parseCSV('a,b\n1,2\n,\n');
  const r = C.convert(rows, { columns: [{ name: 'X', type: 'source', from: 'zzz' }, { name: 'B', type: 'source', from: 'b' }] });
  assert.deepStrictEqual(r.rows, [['', '2']]);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /zzz/);
});

test('convert: 先頭の0（郵便番号・電話番号）を落とさない', () => {
  const rows = C.parseCSV('tel,zip\n0312345678,060-0001\n');
  const r = C.convert(rows, { columns: [{ name: 'T', type: 'source', from: 'tel' }, { name: 'Z', type: 'source', from: 'zip' }] });
  assert.deepStrictEqual(r.rows, [['0312345678', '060-0001']]);
});

test('validateRules: 不正なtypeを弾く', () => {
  assert.throws(() => C.validateRules({ columns: [{ name: 'a', type: 'nope' }] }), /type/);
  assert.throws(() => C.validateRules({}), /columns/);
});

test('サンプル一式: 入力CSV＋ルールで期待どおりに変換できる', () => {
  const rules = C.validateRules(JSON.parse(fs.readFileSync(ex('sample-rules.json'), 'utf8')));
  const r = C.convert(C.parseCSV(fs.readFileSync(ex('sample-input.csv'), 'utf8')), rules);
  assert.strictEqual(r.rows.length, 4);
  assert.deepStrictEqual(r.warnings, []);
  const h = (n) => r.header.indexOf(n);
  assert.deepStrictEqual(r.rows.map((x) => x[h('明細番号')]), ['0001', '0002', '0001', '0001']);
  assert.strictEqual(r.rows[0][h('注文者住所')], '東京都千代田区千代田1-1サンプルビル101');
  assert.strictEqual(r.rows[0][h('店舗コード')], 'SHOP001');
});
