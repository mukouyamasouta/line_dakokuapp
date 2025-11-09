/**
 * 出退勤打刻 + LINE通知 + スプレッドシート連携アプリ
 * GASバックエンド
 */

// ==================== 設定（必ず変更してください） ====================

// LINEチャネルアクセストークン（LINE Developersから取得）
const LINE_CHANNEL_ACCESS_TOKEN = 'YOZ7UftinQaO3OyBDaloYu4cXzhYtLzmqBzAGNvCIJRg7h+DoqsX0n6OXdfOFZ9vI7/+VIOKgdWLHJ6yBmeAi6kPqz4+FZ3vpHQTBEAQSHA81c9tQLH/8oP8UUyRpnHxvmJ0QlaAjZWiraJeO38tBgdB04t89/1O/w1cDnyilFU=';

// LINEグループID
const LINE_GROUP_ID = 'C5a5b36e27a78ed6cfbb74839a8a9d04e';

// スプレッドシートID（このスクリプトが紐づくスプレッドシート）
const SPREADSHEET_ID = '1wnkRctfWhWjIlxW_Ky1uR2i6NClTb3s3hLjksnLZRDw';

// 研修生ID（固定）
const USER_ID = 'user01';

// アプリURL（デプロイ後に更新してください）
const APP_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';

// ==================== シート名 ====================
const SHEET_MASTER = '研修生マスタ';
const SHEET_RECORDS = '打刻記録';
const SHEET_COMPLETE = '課題完了記録';

// ==================== Webアプリのエントリーポイント ====================

/**
 * GETリクエスト - フロントエンドHTMLを返す
 */
function doGet(e) {
  const path = (e && e.parameter && e.parameter.path) || 'index';

  if (path === 'manifest.json') {
    return ContentService.createTextOutput(getManifestJson())
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (path === 'service-worker.js') {
    return ContentService.createTextOutput(getServiceWorker())
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  if (path === 'style.css') {
    return ContentService.createTextOutput(getStyleCss())
      .setMimeType(ContentService.MimeType.CSS);
  }

  // デフォルト: index.htmlを返す
  return HtmlService.createHtmlOutput(getIndexHtml())
    .setTitle('出退勤打刻アプリ')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * POSTリクエスト - 打刻処理
 */
function doPost(e) {
  try {
    Logger.log('doPost called');

    // eまたはe.postDataがundefinedの場合のチェック
    if (!e || !e.postData) {
      Logger.log('Error: No POST data');
      return createJsonResponse(false, 'リクエストデータがありません');
    }

    let params;

    // URLエンコードされたデータの場合
    if (e.parameter && e.parameter.data) {
      Logger.log('Received URL-encoded data');
      params = JSON.parse(decodeURIComponent(e.parameter.data));
    }
    // JSON形式の場合
    else if (e.postData.contents) {
      Logger.log('Received JSON data');
      params = JSON.parse(e.postData.contents);
    }
    else {
      Logger.log('Error: Invalid POST data format');
      return createJsonResponse(false, 'リクエストデータの形式が不正です');
    }

    const action = params.action;
    Logger.log('POST action: ' + action);

    if (action === 'start') {
      return handleClockIn();
    } else if (action === 'end') {
      return handleClockOut();
    } else if (action === 'complete') {
      return handleComplete(params.appUrl);
    } else {
      return createJsonResponse(false, '不正なアクションです');
    }
  } catch (error) {
    Logger.log('Error in doPost: ' + error);
    Logger.log('Error stack: ' + error.stack);
    return createJsonResponse(false, 'エラーが発生しました: ' + error.message);
  }
}

// ==================== 打刻処理 ====================

/**
 * 出勤打刻処理
 */
function handleClockIn() {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const masterSheet = ss.getSheetByName(SHEET_MASTER);
    const recordSheet = ss.getSheetByName(SHEET_RECORDS);

    // 研修生マスタから氏名を取得
    const masterData = masterSheet.getDataRange().getValues();
    let userName = '';

    for (let i = 1; i < masterData.length; i++) {
      if (masterData[i][0] === USER_ID) {
        userName = masterData[i][1];
        break;
      }
    }

    if (!userName) {
      return createJsonResponse(false, '研修生情報が見つかりません');
    }

    // 現在日時
    const now = new Date();
    const date = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd');
    const time = Utilities.formatDate(now, 'Asia/Tokyo', 'HH:mm');

    // 打刻記録に追加
    recordSheet.appendRow([
      date,           // 日付
      USER_ID,        // 研修生ID
      userName,       // 氏名
      time,           // 出勤時刻
      '',             // 退勤時刻（空欄）
      ''              // 勤務時間（空欄）
    ]);

    // LINE通知
    const message = `【出勤】\n${userName}（${USER_ID}）\n${date} ${time}`;
    sendLineMessage(message);

    return createJsonResponse(true, '出勤打刻が完了しました');

  } catch (error) {
    Logger.log('Error in handleClockIn: ' + error);
    return createJsonResponse(false, '出勤打刻に失敗しました: ' + error.message);
  }
}

/**
 * 退勤打刻処理
 */
function handleClockOut() {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const recordSheet = ss.getSheetByName(SHEET_RECORDS);

    // 現在日時
    const now = new Date();
    const today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd');
    const currentTime = Utilities.formatDate(now, 'Asia/Tokyo', 'HH:mm');

    // 当日の出勤記録を検索（退勤時刻が空欄の最新行）
    const data = recordSheet.getDataRange().getValues();
    let targetRow = -1;
    let userName = '';
    let startTime = '';

    for (let i = data.length - 1; i >= 1; i--) {
      if (data[i][0] === today && data[i][1] === USER_ID && data[i][4] === '') {
        targetRow = i + 1; // スプレッドシートの行番号（1始まり）
        userName = data[i][2];
        startTime = data[i][3];
        break;
      }
    }

    if (targetRow === -1) {
      return createJsonResponse(false, '本日の出勤記録が見つかりません');
    }

    // 勤務時間を計算
    const workTime = calculateWorkTime(startTime, currentTime);

    // 退勤時刻と勤務時間を記録
    recordSheet.getRange(targetRow, 5).setValue(currentTime); // 退勤時刻
    recordSheet.getRange(targetRow, 6).setValue(workTime);    // 勤務時間

    // LINE通知
    const message = `【退勤】\n${userName}（${USER_ID}）\n出勤：${startTime}\n退勤：${currentTime}\n勤務：${workTime}`;
    sendLineMessage(message);

    return createJsonResponse(true, '退勤打刻が完了しました');

  } catch (error) {
    Logger.log('Error in handleClockOut: ' + error);
    return createJsonResponse(false, '退勤打刻に失敗しました: ' + error.message);
  }
}

/**
 * 課題完了報告処理
 */
function handleComplete(appUrl) {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const masterSheet = ss.getSheetByName(SHEET_MASTER);
    const completeSheet = ss.getSheetByName(SHEET_COMPLETE);

    // 研修生マスタから氏名を取得
    const masterData = masterSheet.getDataRange().getValues();
    let userName = '';

    for (let i = 1; i < masterData.length; i++) {
      if (masterData[i][0] === USER_ID) {
        userName = masterData[i][1];
        break;
      }
    }

    if (!userName) {
      return createJsonResponse(false, '研修生情報が見つかりません');
    }

    // 現在日時
    const now = new Date();
    const datetime = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');

    // 課題完了記録に追加
    completeSheet.appendRow([
      datetime,       // 完了日時
      USER_ID,        // 研修生ID
      userName,       // 氏名
      appUrl || APP_URL, // アプリURL
      ''              // 判定（空欄）
    ]);

    // LINE通知
    const message = `【🎉課題完了報告🎉】\n研修生：${userName}（${USER_ID}）\n完了：${datetime}\n\nアプリURL:\n${appUrl || APP_URL}`;
    sendLineMessage(message);

    return createJsonResponse(true, '課題完了報告を送信しました！');

  } catch (error) {
    Logger.log('Error in handleComplete: ' + error);
    return createJsonResponse(false, '課題完了報告に失敗しました: ' + error.message);
  }
}

// ==================== ユーティリティ関数 ====================

/**
 * 勤務時間を計算（○時間△分 形式）
 */
function calculateWorkTime(startTime, endTime) {
  try {
    const start = parseTime(startTime);
    const end = parseTime(endTime);

    let diffMinutes = (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute);

    if (diffMinutes < 0) {
      diffMinutes += 24 * 60; // 日をまたいだ場合
    }

    const hours = Math.floor(diffMinutes / 60);
    const minutes = diffMinutes % 60;

    return `${hours}時間${minutes}分`;
  } catch (error) {
    return '計算エラー';
  }
}

/**
 * 時刻文字列をパース（HH:mm → {hour, minute}）
 */
function parseTime(timeStr) {
  const parts = timeStr.split(':');
  return {
    hour: parseInt(parts[0], 10),
    minute: parseInt(parts[1], 10)
  };
}

/**
 * LINE Messaging APIでメッセージを送信
 */
function sendLineMessage(message) {
  try {
    const url = 'https://api.line.me/v2/bot/message/push';
    const payload = {
      to: LINE_GROUP_ID,
      messages: [
        {
          type: 'text',
          text: message
        }
      ]
    };

    const options = {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();

    if (responseCode !== 200) {
      Logger.log('LINE API Error: ' + response.getContentText());
    }

  } catch (error) {
    Logger.log('Error sending LINE message: ' + error);
  }
}

/**
 * JSON レスポンスを作成
 */
function createJsonResponse(success, message) {
  const output = ContentService.createTextOutput(
    JSON.stringify({ success: success, message: message })
  );
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ==================== フロントエンド HTML/CSS/JS ====================

/**
 * index.html を返す
 */
function getIndexHtml() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#4CAF50">
  <title>出退勤打刻アプリ</title>

  <!-- PWA Manifest -->
  <link rel="manifest" href="?path=manifest.json">

  <!-- Apple Touch Icon -->
  <link rel="apple-touch-icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%234CAF50' width='100' height='100'/><text y='75' font-size='80' fill='white' text-anchor='middle' x='50'>📋</text></svg>">

  <!-- CSS -->
  <link rel="stylesheet" href="?path=style.css">
</head>
<body>
  <div class="container">
    <header>
      <h1>📋 出退勤打刻アプリ</h1>
    </header>

    <main>
      <div class="user-info">
        <p class="user-name">${USER_ID} / <span id="userName">読み込み中...</span></p>
      </div>

      <div class="button-group">
        <button id="clockInBtn" class="btn btn-primary">
          🌅 出勤
        </button>

        <button id="clockOutBtn" class="btn btn-secondary">
          🌙 退勤
        </button>
      </div>

      <div class="button-group">
        <button id="completeBtn" class="btn btn-success">
          🎉 課題完了報告
        </button>
      </div>

      <div id="statusMessage" class="status-message"></div>
    </main>

    <footer>
      <p>© 2025 勤怠管理システム</p>
    </footer>
  </div>

  <script>
    // API エンドポイント（現在のURL）
    const API_URL = window.location.href.split('?')[0];
    const USER_ID = '${USER_ID}';

    // 要素取得
    const clockInBtn = document.getElementById('clockInBtn');
    const clockOutBtn = document.getElementById('clockOutBtn');
    const completeBtn = document.getElementById('completeBtn');
    const statusMessage = document.getElementById('statusMessage');
    const userNameEl = document.getElementById('userName');

    // ページ読み込み時
    window.addEventListener('DOMContentLoaded', () => {
      loadUserName();
      registerServiceWorker();
    });

    // ユーザー名読み込み（簡易版）
    function loadUserName() {
      userNameEl.textContent = 'あなたの名前';
    }

    // Service Worker 登録
    function registerServiceWorker() {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('?path=service-worker.js')
          .then(reg => console.log('Service Worker registered', reg))
          .catch(err => console.log('Service Worker registration failed', err));
      }
    }

    // 出勤ボタン
    clockInBtn.addEventListener('click', async () => {
      await sendAction('start', '出勤');
    });

    // 退勤ボタン
    clockOutBtn.addEventListener('click', async () => {
      await sendAction('end', '退勤');
    });

    // 課題完了ボタン
    completeBtn.addEventListener('click', async () => {
      if (!confirm('課題完了報告を送信しますか？')) return;
      await sendAction('complete', '課題完了報告', { appUrl: API_URL });
    });

    // アクション送信
    async function sendAction(action, actionName, extraParams = {}) {
      try {
        // ボタン無効化
        disableAllButtons(true);
        showStatus('送信中...', 'info');

        const payload = {
          action: action,
          ...extraParams
        };

        console.log('Sending request:', payload);
        console.log('API URL:', API_URL);

        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: 'data=' + encodeURIComponent(JSON.stringify(payload)),
          redirect: 'manual'
        });

        console.log('Response status:', response.status);
        console.log('Response type:', response.type);

        // リダイレクトの場合
        if (response.status === 0 || response.type === 'opaqueredirect') {
          console.log('Redirect detected, retrying...');
          const redirectResponse = await fetch(API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'data=' + encodeURIComponent(JSON.stringify(payload))
          });

          const text = await redirectResponse.text();
          console.log('Redirect response:', text.substring(0, 200));

          try {
            const result = JSON.parse(text);
            if (result.success) {
              showStatus(result.message, 'success');
            } else {
              showStatus('エラー: ' + result.message, 'error');
            }
          } catch (e) {
            throw new Error('レスポンスのパースに失敗しました。デプロイURLを確認してください。');
          }
          return;
        }

        const text = await response.text();
        console.log('Response text:', text.substring(0, 200));

        try {
          const result = JSON.parse(text);
          console.log('Parsed result:', result);

          if (result.success) {
            showStatus(result.message, 'success');
          } else {
            showStatus('エラー: ' + result.message, 'error');
          }
        } catch (e) {
          console.error('JSON parse error:', e);
          console.error('Response was:', text);
          throw new Error('レスポンスのパースに失敗しました。デプロイURLが正しいか確認してください。');
        }

      } catch (error) {
        console.error('Error:', error);
        showStatus('通信エラー: ' + error.message, 'error');
      } finally {
        // ボタン有効化
        disableAllButtons(false);
      }
    }

    // ステータス表示
    function showStatus(message, type) {
      statusMessage.textContent = message;
      statusMessage.className = 'status-message ' + type;
      statusMessage.style.display = 'block';

      // 5秒後に非表示
      setTimeout(() => {
        statusMessage.style.display = 'none';
      }, 5000);
    }

    // ボタン無効化/有効化
    function disableAllButtons(disabled) {
      clockInBtn.disabled = disabled;
      clockOutBtn.disabled = disabled;
      completeBtn.disabled = disabled;
    }
  </script>
</body>
</html>`;
}

/**
 * style.css を返す
 */
function getStyleCss() {
  return `* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.container {
  background: white;
  border-radius: 20px;
  box-shadow: 0 10px 40px rgba(0,0,0,0.2);
  max-width: 500px;
  width: 100%;
  overflow: hidden;
}

header {
  background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);
  color: white;
  padding: 30px 20px;
  text-align: center;
}

header h1 {
  font-size: 24px;
  font-weight: 600;
}

main {
  padding: 30px 20px;
}

.user-info {
  background: #f5f5f5;
  border-radius: 10px;
  padding: 15px;
  margin-bottom: 30px;
  text-align: center;
}

.user-name {
  font-size: 16px;
  font-weight: 500;
  color: #333;
}

.button-group {
  display: flex;
  gap: 15px;
  margin-bottom: 20px;
}

.button-group:last-of-type {
  margin-bottom: 30px;
}

.btn {
  flex: 1;
  padding: 18px 20px;
  border: none;
  border-radius: 12px;
  font-size: 18px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
}

.btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 6px 12px rgba(0,0,0,0.15);
}

.btn:active:not(:disabled) {
  transform: translateY(0);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);
  color: white;
}

.btn-secondary {
  background: linear-gradient(135deg, #2196F3 0%, #1976D2 100%);
  color: white;
}

.btn-success {
  background: linear-gradient(135deg, #FF9800 0%, #F57C00 100%);
  color: white;
  width: 100%;
}

.status-message {
  padding: 15px;
  border-radius: 10px;
  margin-top: 20px;
  font-weight: 500;
  text-align: center;
  display: none;
}

.status-message.info {
  background: #E3F2FD;
  color: #1976D2;
  border: 2px solid #2196F3;
}

.status-message.success {
  background: #E8F5E9;
  color: #388E3C;
  border: 2px solid #4CAF50;
}

.status-message.error {
  background: #FFEBEE;
  color: #C62828;
  border: 2px solid #F44336;
}

footer {
  background: #f5f5f5;
  padding: 20px;
  text-align: center;
  color: #666;
  font-size: 14px;
}

/* レスポンシブ対応 */
@media (max-width: 480px) {
  .button-group {
    flex-direction: column;
  }

  header h1 {
    font-size: 20px;
  }

  .btn {
    font-size: 16px;
  }
}`;
}

/**
 * manifest.json を返す
 */
function getManifestJson() {
  return `{
  "name": "出退勤打刻アプリ",
  "short_name": "勤怠打刻",
  "description": "出退勤の打刻とLINE通知を行うPWAアプリ",
  "start_url": "${APP_URL}",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#4CAF50",
  "orientation": "portrait",
  "icons": [
    {
      "src": "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><rect fill='%234CAF50' width='512' height='512'/><text y='400' font-size='380' fill='white' text-anchor='middle' x='256'>📋</text></svg>",
      "sizes": "512x512",
      "type": "image/svg+xml",
      "purpose": "any maskable"
    }
  ]
}`;
}

/**
 * service-worker.js を返す
 */
function getServiceWorker() {
  return `const CACHE_NAME = 'attendance-app-v1';
const urlsToCache = [
  './',
  '?path=style.css',
  '?path=manifest.json'
];

// インストール時
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
  self.skipWaiting();
});

// フェッチ時
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // キャッシュがあればそれを返す、なければネットワークから取得
        return response || fetch(event.request);
      })
  );
});

// アクティベーション時（古いキャッシュ削除）
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});`;
}
