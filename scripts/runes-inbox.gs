const SPREADSHEET_ID = 'PASTE_GOOGLE_SPREADSHEET_ID_HERE';
const SHEET_NAME = 'Предложения рун';
const VALID_CLASSES = [
  'Оборотень', 'Друид', 'Странник', 'Воин', 'Маг', 'Стрелок', 'Жрец', 'Лучник',
  'Паладин', 'Убийца', 'Шаман', 'Бард', 'Мистик', 'Страж', 'Дух Крови', 'Жнец', 'Призрак', 'Канглонг'
];
const HEADERS = ['Дата получения', 'Класс', 'Автор', 'PvE руны', 'PvP руны', 'Дополнительные руны', 'Примечание', 'Статус'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Руны')
    .addItem('Оформить таблицу заявок', 'setupInboxSheet')
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
      if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
      sheet.appendRow([
        new Date(), submission.class, safeCell(submission.author), safeCell(submission.pve),
        safeCell(submission.pvp), safeCell(submission.additional), safeCell(submission.note), 'На проверке'
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
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  formatInboxSheet_(sheet);
}

function formatInboxSheet_(sheet) {
  const columns = HEADERS.length;
  const rows = sheet.getMaxRows();
  const allRows = sheet.getRange(1, 1, rows, columns);
  if (sheet.getBandings().length === 0) allRows.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREEN);
  const banding = sheet.getBandings()[0];
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

  [155, 135, 165, 230, 230, 235, 330, 150].forEach((width, index) => sheet.setColumnWidth(index + 1, width));
  if (rows > 1) {
    sheet.getRange(2, 1, rows - 1, columns)
      .setFontFamily('Arial')
      .setFontSize(10)
      .setFontColor('#26372d')
      .setVerticalAlignment('top')
      .setWrap(true);
    sheet.getRange(2, 1, rows - 1, 1).setNumberFormat('dd.mm.yyyy hh:mm');
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
  if (!sheet.getFilter()) sheet.getRange(1, 1, rows, columns).createFilter();
  if (sheet.getLastRow() > 1) sheet.autoResizeRows(2, sheet.getLastRow() - 1);
}

function safeCell(value) {
  return /^[=+@\-]/.test(value) ? `'${value}` : value;
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}