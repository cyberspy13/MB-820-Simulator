/* Templates people can fill in with Word, Excel or a text editor. They hold the original sample questions. */
(function () {
  'use strict';
  const Sim = window.Sim = window.Sim || {};

  const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/';
  const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  function esc(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function types(list) {
    return HEAD + '<Types xmlns="' + PACKAGE + 'content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      list.map(function (t) { return '<Override PartName="' + t[0] + '" ContentType="application/vnd.openxmlformats-officedocument.' + t[1] + '+xml"/>'; }).join('') + '</Types>';
  }

  function rels(list) {
    return HEAD + '<Relationships xmlns="' + PACKAGE + 'relationships">' + list.map(function (r, n) {
      return '<Relationship Id="rId' + (n + 1) + '" Type="' + OFFICE + '/' + r[0] + '" Target="' + r[1] + '"/>';
    }).join('') + '</Relationships>';
  }

  function wordFile() {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const body = Sim.SAMPLE_TEXT.split('\n').map(function (line) {
      const bold = /^(?:Question \d+|Answer:|Explanation)/.test(line);
      const code = /^ {4}|^(?:procedure|var|begin|end;)/.test(line);
      return '<w:p><w:pPr><w:spacing w:after="60"/></w:pPr>' + (line ? '<w:r><w:rPr>' + (code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : '') + (bold ? '<w:b/>' : '') + '</w:rPr><w:t xml:space="preserve">' + esc(line) + '</w:t></w:r>' : '') + '</w:p>';
    }).join('');
    return Sim.zip.write({
      '[Content_Types].xml': types([['/word/document.xml', 'wordprocessingml.document.main']]),
      '_rels/.rels': rels([['officeDocument', 'word/document.xml']]),
      'word/document.xml': HEAD + '<w:document xmlns:w="' + W + '"><w:body>' + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>'
    });
  }

  const COLUMNS = ['No.', 'Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Option E', 'Correct answer', 'Explanation', 'Topic', 'Type'];
  const WIDTHS = [6, 60, 24, 24, 24, 24, 24, 34, 50, 18, 16];
  const ROWS = [
    ['1', 'You add a field named Loyalty Level to the Customer table of the base application.\nWhich object type should you create?', 'table', 'tableextension', 'pageextension', 'enumextension', '', 'B', 'A tableextension adds fields to a table that another app owns.', 'Development', 'One answer'],
    ['2', 'You want a page to be usable as a REST endpoint under /api/.\nWhich two properties must the page have?', 'PageType = API', 'UsageCategory = Lists', 'EntitySetName', 'CardPageId', 'RefreshOnActivate = true', 'A, C', 'API pages use PageType = API and need an EntityName and EntitySetName.', 'Integration', 'Several answers'],
    ['3', 'The value of a FlowField is stored in the database.', '', '', '', '', '', 'False', 'FlowFields are calculated when needed.', 'Development', 'True or false'],
    ['4', 'You are preparing a project in Visual Studio Code.\nWhich file holds each setting?', '', '', '', '', '', 'Dependencies on other apps -> app.json\nServer to publish to -> launch.json\nApp version number -> app.json', 'app.json is the manifest of the app. launch.json describes where to publish.', 'Development', 'Match'],
    ['5', 'You want to find out why a posting routine stops with an error.\nPut the actions in the correct order.', '', '', '', '', '', 'Set a breakpoint in the AL code.\nPublish the app with debugging by pressing F5.\nRun the posting routine in the web client.', 'The debugger has to be attached before the code runs.', 'Debugging', 'Order']
  ];

  function excelFile() {
    const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const rowXml = function (cells, r, style) {
      return '<row r="' + r + '">' + cells.map(function (t, c) {
        return t === '' ? '' : '<c r="' + String.fromCharCode(65 + c) + r + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' + esc(t) + '</t></is></c>';
      }).join('') + '</row>';
    };
    return Sim.zip.write({
      '[Content_Types].xml': types([['/xl/workbook.xml', 'spreadsheetml.sheet.main'], ['/xl/worksheets/sheet1.xml', 'spreadsheetml.worksheet'], ['/xl/styles.xml', 'spreadsheetml.styles']]),
      '_rels/.rels': rels([['officeDocument', 'xl/workbook.xml']]),
      'xl/workbook.xml': HEAD + '<workbook xmlns="' + M + '" xmlns:r="' + OFFICE + '"><sheets><sheet name="Questions" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': rels([['worksheet', 'worksheets/sheet1.xml'], ['styles', 'styles.xml']]),
      'xl/styles.xml': HEAD + '<styleSheet xmlns="' + M + '"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': HEAD + '<worksheet xmlns="' + M + '"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>' +
        WIDTHS.map(function (w, n) { return '<col min="' + (n + 1) + '" max="' + (n + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols><sheetData>' +
        rowXml(COLUMNS, 1, 1) + ROWS.map(function (r, n) { return rowXml(r, n + 2, 2); }).join('') + '</sheetData></worksheet>'
    });
  }

  Sim.templates = {
    wordFile: wordFile,
    excelFile: excelFile,
    word: function () { Sim.dom.downloadBlob('Question template.docx', wordFile()); },
    excel: function () { Sim.dom.downloadBlob('Question template.xlsx', excelFile()); },
    text: function () { Sim.dom.download('Question template.txt', Sim.SAMPLE_TEXT.replace(/\n/g, '\r\n'), 'text/plain'); }
  };
})();
