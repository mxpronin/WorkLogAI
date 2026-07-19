import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import pdfMake from 'pdfmake/build/pdfmake.js';
import 'pdfmake/build/vfs_fonts.js';

import { buildSpprExportReport } from '../src/domain/sppr-report.js';
import { createExcelReportBlob, createPdfReportBlob } from '../src/reports/export.js';

const tasks = [
  { id: 'a', spprNumber: 'СППР-1', title: 'Интеграция' },
  { id: 'b', spprNumber: 'СППР-2', title: 'Документация' },
];

test('report uses saved allocations only for finished days', () => {
  const report = buildSpprExportReport({
    fromDate: '2026-07-13',
    toDate: '2026-07-19',
    tasks,
    entries: [
      { id: 'e1', taskId: 'a', localDate: '2026-07-13', note: 'Факт', spprDescription: 'Текст СППР', actualMinutes: 90 },
      { id: 'e2', taskId: 'b', localDate: '2026-07-14', note: 'Активная работа', actualMinutes: 45, excludeFromSppr: true },
      { id: 'e3', taskId: 'b', localDate: '2026-07-15', note: 'Черновая работа', actualMinutes: 30 },
    ],
    workDays: [
      {
        localDate: '2026-07-13',
        state: 'finished',
        targetMinutes: 480,
        allocations: [{
          taskId: 'a',
          spprMinutes: 480,
          description: 'Сохранённое распределение',
          entryAllocations: [{ entryId: 'e1', spprMinutes: 480 }],
        }],
      },
      { localDate: '2026-07-14', state: 'active', allocations: [{ taskId: 'b', spprMinutes: 999 }] },
      { localDate: '2026-07-15', state: 'draft', allocations: [] },
    ],
  });

  assert.equal(report.totalActualMinutes, 165);
  assert.equal(report.totalSpprMinutes, 480);
  assert.equal(report.finishedDayCount, 1);
  assert.equal(report.activeDayCount, 1);
  assert.equal(report.draftDayCount, 1);
  assert.equal(report.days.find((day) => day.localDate === '2026-07-14').spprMinutes, null);
  assert.equal(report.rows.find((row) => row.localDate === '2026-07-14').spprMinutes, null);
  assert.match(report.rows[0].description, /Текст СППР|Сохранённое распределение/);
  assert.equal(report.chartPoints.length, 3);
});

test('long periods use monthly grouping and empty periods stay valid', () => {
  const yearly = buildSpprExportReport({
    fromDate: '2026-01-01',
    toDate: '2026-12-31',
    tasks,
    entries: [
      { id: 'e1', taskId: 'a', localDate: '2026-01-10', note: 'Январь', actualMinutes: 60 },
      { id: 'e2', taskId: 'a', localDate: '2026-07-10', note: 'Июль', actualMinutes: 60 },
    ],
    workDays: [],
  });
  assert.deepEqual(yearly.chartPoints.map((point) => point.key), ['month-2026-01', 'month-2026-07']);

  const empty = buildSpprExportReport({
    fromDate: '2026-02-01',
    toDate: '2026-02-07',
    tasks,
    entries: [],
    workDays: [],
  });
  assert.equal(empty.dayCount, 0);
  assert.deepEqual(empty.rows, []);
});

test('invalid report ranges are rejected', () => {
  assert.throws(() => buildSpprExportReport({
    fromDate: '2026-08-02',
    toDate: '2026-08-01',
    tasks: [],
    entries: [],
    workDays: [],
  }), /Дата начала/);
});

test('Excel export is a real XLSX with formatted Russian details', async () => {
  const report = buildSpprExportReport({
    fromDate: '2026-07-13',
    toDate: '2026-07-19',
    tasks,
    entries: [{ id: 'e1', taskId: 'a', localDate: '2026-07-13', note: 'Очень длинное описание работы на русском языке', actualMinutes: 90 }],
    workDays: [{ localDate: '2026-07-13', state: 'active', allocations: [] }],
  });
  const blob = await createExcelReportBlob(report, ExcelJS);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 2)], [0x50, 0x4B]);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet('Отчёт СППР');
  assert.equal(workbook.worksheets.length, 1);
  assert.equal(sheet.getCell('A1').value, 'WorkLog AI · Подробный отчёт СППР');
  assert.equal(sheet.getCell('G26').value, 'Очень длинное описание работы на русском языке');
  assert.ok(sheet.autoFilter);
  assert.equal(sheet.views[0].ySplit, 25);
});

test('PDF export creates a real PDF with Russian content', async () => {
  const report = buildSpprExportReport({
    fromDate: '2026-07-13',
    toDate: '2026-07-19',
    tasks,
    entries: [],
    workDays: [],
  });
  const blob = await createPdfReportBlob(report, pdfMake);
  assert.equal(blob.type, 'application/pdf');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  assert.ok(blob.size > 5_000);
});
