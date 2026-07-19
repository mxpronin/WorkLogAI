import { formatMinutes } from '../utils/format.js';

const COLORS = {
  navy: '#132238',
  blue: '#356AE6',
  violet: '#7457D9',
  green: '#1B9C68',
  amber: '#E0952D',
  light: '#F3F6FA',
  border: '#D9E0E8',
  text: '#172033',
  muted: '#667085',
};

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function chartSvg(items, {
  title,
  valueKeys,
  colors,
  width = 720,
  height = 270,
  maxItems = 16,
} = {}) {
  const values = items.slice(0, maxItems);
  const padding = { left: 54, right: 18, top: 42, bottom: 58 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maximum = Math.max(60, ...values.flatMap((item) => valueKeys.map((key) => Number(item[key]) || 0)));
  const groupWidth = values.length ? chartWidth / values.length : chartWidth;
  const barWidth = Math.max(3, Math.min(18, groupWidth / (valueKeys.length + 1)));
  const grid = [0, .25, .5, .75, 1].map((ratio) => {
    const y = padding.top + chartHeight - chartHeight * ratio;
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="${COLORS.border}" stroke-width="1"/>
      <text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="${COLORS.muted}">${Math.round(maximum * ratio / 60)}ч</text>`;
  }).join('');
  const bars = values.map((item, index) => {
    const center = padding.left + groupWidth * index + groupWidth / 2;
    const itemBars = valueKeys.map((key, keyIndex) => {
      const value = Number(item[key]) || 0;
      const barHeight = value / maximum * chartHeight;
      const x = center + (keyIndex - (valueKeys.length - 1) / 2) * (barWidth + 3) - barWidth / 2;
      return `<rect x="${x}" y="${padding.top + chartHeight - barHeight}" width="${barWidth}" height="${barHeight}" rx="2" fill="${colors[keyIndex]}"/>`;
    }).join('');
    const label = escapeXml(item.label);
    return `${itemBars}<text x="${center}" y="${height - 32}" text-anchor="middle" font-size="9" fill="${COLORS.muted}" transform="rotate(-28 ${center} ${height - 32})">${label.slice(0, 18)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" rx="12" fill="#FFFFFF"/>
    <text x="18" y="25" font-size="16" font-family="Roboto,Arial,sans-serif" font-weight="700" fill="${COLORS.text}">${escapeXml(title)}</text>
    ${grid}${bars}
  </svg>`;
}

function dailyChartSvg(report) {
  return chartSvg(report.chartPoints, {
    title: 'Фактическое и СППР-время',
    valueKeys: ['actualMinutes', 'spprMinutes'],
    colors: [COLORS.green, COLORS.violet],
  });
}

function taskChartSvg(report) {
  return chartSvg(report.topTasks, {
    title: 'Рейтинг задач по времени',
    valueKeys: ['actualMinutes', 'spprMinutes'],
    colors: [COLORS.blue, COLORS.amber],
  });
}

async function svgToPngDataUrl(svg, width = 720, height = 270) {
  if (!globalThis.document || !globalThis.Image) return null;
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', reject, { once: true });
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function styleCell(cell, { fill, color = 'FFFFFFFF', bold = false, size = 11, align = 'left' } = {}) {
  if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill.replace('#', 'FF') } };
  cell.font = { name: 'Arial', size, bold, color: { argb: color.replace('#', 'FF') } };
  cell.alignment = { vertical: 'middle', horizontal: align, wrapText: true };
}

function addMetric(worksheet, range, label, value, color) {
  worksheet.mergeCells(range);
  const cell = worksheet.getCell(range.split(':')[0]);
  cell.value = `${label}\n${value}`;
  styleCell(cell, { fill: color, bold: true, size: 13 });
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
}

export async function createExcelReportBlob(report, ExcelJS = globalThis.ExcelJS) {
  if (!ExcelJS?.Workbook) throw new Error('Модуль создания Excel не загружен.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WorkLog AI';
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet('Отчёт СППР', {
    views: [{ state: 'frozen', ySplit: 25 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  worksheet.columns = [
    { key: 'date', width: 14 },
    { key: 'status', width: 14 },
    { key: 'number', width: 18 },
    { key: 'title', width: 28 },
    { key: 'actual', width: 14 },
    { key: 'sppr', width: 14 },
    { key: 'description', width: 72 },
  ];
  worksheet.mergeCells('A1:G1');
  worksheet.getCell('A1').value = 'WorkLog AI · Подробный отчёт СППР';
  styleCell(worksheet.getCell('A1'), { fill: COLORS.navy, bold: true, size: 20, align: 'center' });
  worksheet.getRow(1).height = 34;
  worksheet.mergeCells('A2:G2');
  worksheet.getCell('A2').value = report.periodLabel;
  styleCell(worksheet.getCell('A2'), { fill: '#E9EEF7', color: COLORS.text, bold: true, size: 12, align: 'center' });
  worksheet.getRow(2).height = 24;

  addMetric(worksheet, 'A4:B5', 'Фактическое время', formatMinutes(report.totalActualMinutes), COLORS.green);
  addMetric(worksheet, 'C4:D5', 'СППР-время', formatMinutes(report.totalSpprMinutes), COLORS.violet);
  addMetric(worksheet, 'E4:F5', 'Задач', String(report.taskCount), COLORS.blue);
  addMetric(worksheet, 'G4:G5', 'Дней', String(report.dayCount), COLORS.amber);
  worksheet.getRow(4).height = 30;
  worksheet.getRow(5).height = 30;

  const [dailyPng, taskPng] = await Promise.all([
    svgToPngDataUrl(dailyChartSvg(report)),
    svgToPngDataUrl(taskChartSvg(report)),
  ]);
  if (dailyPng) {
    const imageId = workbook.addImage({ base64: dailyPng, extension: 'png' });
    worksheet.addImage(imageId, { tl: { col: 0, row: 6 }, ext: { width: 650, height: 245 } });
  }
  if (taskPng) {
    const imageId = workbook.addImage({ base64: taskPng, extension: 'png' });
    worksheet.addImage(imageId, { tl: { col: 3.65, row: 6 }, ext: { width: 650, height: 245 } });
  }
  for (let row = 7; row <= 23; row += 1) worksheet.getRow(row).height = 16;

  const headerRowNumber = 25;
  const header = worksheet.getRow(headerRowNumber);
  header.values = ['Дата', 'Статус', 'Номер СППР', 'Задача', 'Факт, ч', 'СППР, ч', 'Описание'];
  header.eachCell((cell) => styleCell(cell, { fill: COLORS.navy, bold: true, align: 'center' }));
  header.height = 28;

  report.rows.forEach((row) => {
    const excelRow = worksheet.addRow({
      date: row.localDate,
      status: row.status,
      number: row.taskNumber,
      title: row.taskTitle,
      actual: row.actualMinutes / 60,
      sppr: row.spprMinutes === null ? null : row.spprMinutes / 60,
      description: row.description,
    });
    excelRow.height = Math.max(24, Math.min(90, 18 + Math.ceil(row.description.length / 80) * 12));
    excelRow.eachCell((cell, column) => {
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = {
        bottom: { style: 'thin', color: { argb: COLORS.border.replace('#', 'FF') } },
      };
      if (column === 5 || column === 6) cell.numFmt = '0.00';
    });
  });
  worksheet.autoFilter = { from: `A${headerRowNumber}`, to: `G${Math.max(headerRowNumber, worksheet.rowCount)}` };
  worksheet.getRow(worksheet.rowCount + 2).values = [
    '', '', '', 'Итого',
    report.totalActualMinutes / 60,
    report.totalSpprMinutes / 60,
    `Завершённых дней: ${report.finishedDayCount}; активных: ${report.activeDayCount}; черновиков: ${report.draftDayCount}`,
  ];
  const totalRow = worksheet.getRow(worksheet.rowCount);
  totalRow.eachCell((cell) => styleCell(cell, { fill: '#E9EEF7', color: COLORS.text, bold: true }));
  totalRow.getCell(5).numFmt = '0.00';
  totalRow.getCell(6).numFmt = '0.00';

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function pdfMetric(label, value, color) {
  return {
    margin: [3, 3],
    table: {
      widths: ['*'],
      body: [[{
        stack: [
          { text: label, fontSize: 9, color: '#667085' },
          { text: value, fontSize: 17, bold: true, color },
        ],
        margin: [9, 7],
      }]],
    },
    layout: { fillColor: () => '#F3F6FA', hLineColor: () => '#D9E0E8', vLineColor: () => '#D9E0E8' },
  };
}

export async function createPdfReportBlob(report, pdfMake = globalThis.pdfMake) {
  if (!pdfMake?.createPdf) throw new Error('Модуль создания PDF не загружен.');
  const content = [
    { text: 'WorkLog AI · Подробный отчёт СППР', style: 'title' },
    { text: report.periodLabel, style: 'period' },
    {
      columns: [
        pdfMetric('Фактическое время', formatMinutes(report.totalActualMinutes), COLORS.green),
        pdfMetric('СППР-время', formatMinutes(report.totalSpprMinutes), COLORS.violet),
        pdfMetric('Задач', String(report.taskCount), COLORS.blue),
        pdfMetric('Дней с данными', String(report.dayCount), COLORS.amber),
      ],
      columnGap: 6,
      margin: [0, 8, 0, 12],
    },
    {
      columns: [
        { svg: dailyChartSvg(report), width: 365 },
        { svg: taskChartSvg(report), width: 365 },
      ],
      columnGap: 10,
      pageBreak: 'after',
    },
  ];

  report.days.forEach((day, dayIndex) => {
    content.push({
      columns: [
        { text: day.formattedDate, bold: true, fontSize: 13, color: COLORS.navy },
        { text: `${day.status} · Факт ${formatMinutes(day.actualMinutes)}${day.spprMinutes === null ? '' : ` · СППР ${formatMinutes(day.spprMinutes)}`}`, alignment: 'right', fontSize: 9, color: COLORS.muted },
      ],
      margin: [0, dayIndex ? 12 : 0, 0, 5],
    });
    content.push({
      table: {
        headerRows: 1,
        widths: [66, 120, 58, 58, '*'],
        body: [
          [
            { text: 'Номер', style: 'tableHeader' },
            { text: 'Задача', style: 'tableHeader' },
            { text: 'Факт', style: 'tableHeader' },
            { text: 'СППР', style: 'tableHeader' },
            { text: 'Описание', style: 'tableHeader' },
          ],
          ...day.rows.map((row) => [
            row.taskNumber,
            row.taskTitle,
            formatMinutes(row.actualMinutes),
            row.spprMinutes === null ? '—' : formatMinutes(row.spprMinutes),
            row.description || '—',
          ]),
        ],
      },
      layout: {
        fillColor: (rowIndex) => rowIndex === 0 ? COLORS.navy : rowIndex % 2 ? '#FFFFFF' : '#F7F9FC',
        hLineColor: () => COLORS.border,
        vLineColor: () => COLORS.border,
      },
    });
  });

  const definition = {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [30, 32, 30, 34],
    footer: (currentPage, pageCount) => ({
      text: `WorkLog AI · ${currentPage} / ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      color: COLORS.muted,
      margin: [0, 8, 0, 0],
    }),
    defaultStyle: { font: 'Roboto', fontSize: 9, color: COLORS.text },
    styles: {
      title: { fontSize: 22, bold: true, color: COLORS.navy },
      period: { fontSize: 11, color: COLORS.muted, margin: [0, 3, 0, 0] },
      tableHeader: { bold: true, color: '#FFFFFF', alignment: 'center' },
    },
    content,
  };
  const output = pdfMake.createPdf(definition);
  const result = output.getBlob();
  if (result?.then) return result;
  return new Promise((resolve, reject) => {
    try {
      output.getBlob(resolve);
    } catch (error) {
      reject(error);
    }
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result).split(',')[1]), { once: true });
    reader.addEventListener('error', () => reject(reader.error), { once: true });
    reader.readAsDataURL(blob);
  });
}

export async function deliverReportFile({
  blob,
  filename,
  title,
  filesystem,
  share,
  browserDownload,
  directoryName = 'worklog-exports',
}) {
  if (!filesystem || !share) {
    browserDownload(blob, filename, blob.type);
    return { shared: false };
  }
  const exportDirectory = directoryName;
  try {
    await filesystem.rmdir({ path: exportDirectory, directory: 'CACHE', recursive: true });
  } catch {
    // The cache directory does not exist on the first export.
  }
  await filesystem.mkdir({ path: exportDirectory, directory: 'CACHE', recursive: true });
  const result = await filesystem.writeFile({
    path: `${exportDirectory}/${filename}`,
    directory: 'CACHE',
    data: await blobToBase64(blob),
  });
  const canShare = await share.canShare?.();
  if (canShare && canShare.value === false) throw new Error('На устройстве недоступно системное меню отправки файлов.');
  await share.share({
    title,
    text: title,
    files: [result.uri],
    dialogTitle: 'Отправить отчёт',
  });
  return { shared: true, uri: result.uri };
}
