const SPREADSHEET_ID = 'PASTE_GOOGLE_SPREADSHEET_ID_HERE';
const SHEET_NAME = 'Предложения рун';
const VALID_CLASSES = [
  'Оборотень', 'Друид', 'Странник', 'Воин', 'Маг', 'Стрелок', 'Жрец', 'Лучник',
  'Паладин', 'Убийца', 'Шаман', 'Бард', 'Мистик', 'Страж', 'Дух Крови', 'Жнец', 'Призрак', 'Канглонг'
];
const HEADERS = ['Дата получения', 'Класс', 'Автор', 'PvE руны', 'PvP руны', 'Дополнительные руны', 'Примечание', 'Статус', 'ID', 'JSON-объект для runes'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Руны')
    .addItem('Обновить оформление и JSON', 'setupInboxSheet')
    .addToUi();
}

function doPost(event) {
  try {
    const data = JSON.parse(event?.postData?.contents || '{}');
    const submission = validateSubmission(data);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
      ensureHeaders_(sheet);
      const receivedAt = new Date();
      const entry = createCatalogEntry_(submission, `rune-${Utilities.getUuid()}`, receivedAt);
      sheet.appendRow([
        receivedAt, submission.class, safeCell(submission.author), safeCell(submission.pve),
        safeCell(submission.pvp), safeCell(submission.additional), safeCell(submission.note), 'На проверке',
        entry.id, JSON.stringify(entry)
      ]);
      formatInboxSheet_(sheet);
    } finally {
      lock.releaseLock();
    }
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error(error);
    return jsonResponse({ ok: false, error: String(error.message || error) });
  }
}

function validateSubmission(data) {
  if (!VALID_CLASSES.includes(data.class)) throw new Error('Неизвестный класс.');
  const fields = { author: 100, pve: 2000, pvp: 2000, additional: 2000, note: 500 };
  const result = { class: data.class };
  Object.entries(fields).forEach(([field, max]) => {
    const value = String(data[field] || '').trim();
    if (value.length > max) throw new Error(`Поле ${field} слишком длинное.`);
    result[field] = value;
  });
  if (!result.author || !result.pve || !result.pvp) throw new Error('Заполните автора, PvE и PvP руны.');
  return result;
}

function setupInboxSheet() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
  ensureHeaders_(sheet);
  refreshCatalogEntries_(sheet);
  formatInboxSheet_(sheet);
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  else sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
}

function refreshCatalogEntries_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const rows = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  const idAndJson = rows.map(row => {
    if (!row[1]) return [row[8] || '', row[9] || ''];
    const id = row[8] || `rune-${Utilities.getUuid()}`;
    const receivedAt = row[0] instanceof Date ? row[0] : new Date(row[0] || Date.now());
    const submission = {
      class: String(row[1]), author: String(row[2] || ''), pve: String(row[3] || ''),
      pvp: String(row[4] || ''), additional: String(row[5] || ''), note: String(row[6] || '')
    };
    return [id, JSON.stringify(createCatalogEntry_(submission, id, receivedAt))];
  });
  sheet.getRange(2, 9, idAndJson.length, 2).setValues(idAndJson);
}

function createCatalogEntry_(submission, id, receivedAt) {
  return {
    id,
    class: submission.class,
    pve: submission.pve,
    pvp: submission.pvp,
    additional: submission.additional,
    author: submission.author,
    note: submission.note,
    addedAt: Utilities.formatDate(receivedAt, Session.getScriptTimeZone(), 'yyyy-MM-dd')
  };
}

function formatInboxSheet_(sheet) {
  const columns = HEADERS.length;
  const rows = sheet.getMaxRows();
  const allRows = sheet.getRange(1, 1, rows, columns);
  let bandings = sheet.getBandings();
  if (!bandings.length || bandings[0].getRange().getNumColumns() !== columns) {
    bandings.forEach(item => item.remove());
    allRows.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREEN);
    bandings = sheet.getBandings();
  }
  const banding = bandings[0];
  if (banding) {
    banding.setHeaderRowColor('#183b2b');
    banding.setFirstRowColor('#ffffff');
    banding.setSecondRowColor('#f0f5f1');
  }

  sheet.setFrozenRows(1);
  sheet.setHiddenGridlines(true);
  sheet.setTabColor('#315f45');
  sheet.setRowHeight(1, 48);
  sheet.getRange(1, 1, 1, columns)
    .setBackground('#183b2b')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontFamily('Arial')
    .setFontSize(11)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true)
    .setBorder(null, null, true, null, false, false, '#c9a85d', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  [155, 135, 165, 230, 230, 235, 330, 150, 250, 480].forEach((width, index) => sheet.setColumnWidth(index + 1, width));
  if (rows > 1) {
    sheet.getRange(2, 1, rows - 1, columns)
      .setFontFamily('Arial')
      .setFontSize(10)
      .setFontColor('#26372d')
      .setVerticalAlignment('top')
      .setWrap(true);
    sheet.getRange(2, 1, rows - 1, 1).setNumberFormat('dd.mm.yyyy hh:mm');
    sheet.getRange(2, 10, rows - 1, 1).setFontFamily('Consolas').setFontSize(9).setFontColor('#345f46');
    const statusRange = sheet.getRange(2, 8, rows - 1, 1);
    const statusValidation = SpreadsheetApp.newDataValidation()
      .requireValueInList(['На проверке', 'Одобрено', 'Отклонено'], true)
      .setAllowInvalid(false)
      .build();
    statusRange.setDataValidation(statusValidation);

    if (sheet.getConditionalFormatRules().length === 0) {
      sheet.setConditionalFormatRules([
        SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('На проверке').setBackground('#fff2cc').setRanges([statusRange]).build(),
        SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Одобрено').setBackground('#d9ead3').setRanges([statusRange]).build(),
        SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Отклонено').setBackground('#f4cccc').setRanges([statusRange]).build()
      ]);
    }
  }
  const filter = sheet.getFilter();
  if (!filter || filter.getRange().getNumColumns() !== columns) {
    filter?.remove();
    allRows.createFilter();
  }
  if (sheet.getLastRow() > 1) sheet.autoResizeRows(2, sheet.getLastRow() - 1);
}

function safeCell(value) {
  return /^[=+@\-]/.test(value) ? `'${value}` : value;
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}