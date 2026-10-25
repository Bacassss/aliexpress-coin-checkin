const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PROFILE = path.join(DATA, 'edge-profile');
const LOGS = path.join(DATA, 'logs');
const SHOTS = path.join(DATA, 'screenshots');
const STATE_FILE = path.join(DATA, 'state.json');
const mode = (process.argv[2] || 'run').toLowerCase();
const headed = mode === 'login' || process.env.ALIEXPRESS_HEADLESS !== '1';
const coinUrls = [
  'https://www.aliexpress.com/p/coin-pc-index/index.html',
  'https://m.aliexpress.com/p/coin-index/index.html?from=syicon&fromApp=true&_lang=ko_KR&_currency=KRW'
];

for (const dir of [DATA, PROFILE, LOGS, SHOTS]) fs.mkdirSync(dir, { recursive: true });

function stamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T').replaceAll(':', '-');
}

function writeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(path.join(LOGS, `${new Date().toISOString().slice(0, 10)}.log`), line + '\n', 'utf8');
}

// 알리익스프레스 출석 회차: 한국시간 16:00부터 다음 날 16:00까지.
function attendanceWindowKey() {
  const korea = new Date(Date.now() + 9 * 60 * 60 * 1000);
  if (korea.getUTCHours() < 16) korea.setUTCDate(korea.getUTCDate() - 1);
  return korea.toISOString().slice(0, 10);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function markWindowDone(result) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    completedWindow: attendanceWindowKey(),
    completedAt: new Date().toISOString(),
    result
  }, null, 2), 'utf8');
}

async function pageLooksLoggedOut(page) {
  const url = page.url().toLowerCase();
  if (/login|signin|passport/.test(url)) return true;
  return await page.locator('input[type="password"]').count() > 0;
}

async function hasSecurityChallenge(page) {
  const body = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).toLowerCase();
  return /captcha|verify you are human|security verification|slide to verify|보안 확인|본인 확인|인증/.test(body);
}

async function tryCheckIn(page) {
  const patterns = [
    /^\s*(check[ -]?in|daily check[ -]?in)\s*$/i,
    /^\s*(claim|claim now|collect|collect now|get coins?)\s*$/i,
    /^\s*(출석|출석하기|체크인|받기|지금 받기|수령|수령하기|코인 받기)\s*$/i,
    /^\s*(签到|立即签到|领取|立即领取)\s*$/
  ];
  const clickedLabels = [];

  async function clickExactReceiveText() {
    const labels = ['받기', '지금 받기', '수령', '수령하기', 'Claim', 'Claim now', 'Collect', 'Collect now', '领取', '立即领取'];
    for (const label of labels) {
      const matches = page.getByText(label, { exact: true });
      const count = Math.min(await matches.count(), 20);
      for (let i = 0; i < count; i++) {
        const textNode = matches.nth(i);
        if (!(await textNode.isVisible().catch(() => false))) continue;

        // 텍스트 노드 자체 또는 가장 가까운 실제 클릭 영역을 차례로 시도한다.
        const targets = [
          textNode,
          textNode.locator('xpath=ancestor-or-self::button[1]'),
          textNode.locator('xpath=ancestor-or-self::*[@role="button"][1]'),
          textNode.locator('xpath=ancestor-or-self::a[1]'),
          textNode.locator('xpath=parent::*')
        ];
        for (const target of targets) {
          if ((await target.count().catch(() => 0)) === 0) continue;
          const didClick = await target.first().click({ timeout: 4000 }).then(() => true).catch(() => false);
          if (didClick) {
            writeLog(`후속 받기 버튼 우선 클릭: ${JSON.stringify(label)}`);
            return label;
          }
        }
      }
    }
    return null;
  }

  // 출석 버튼 뒤 팝업의 '받기' 버튼이 따로 나타날 수 있어 최대 4단계까지 처리한다.
  for (let step = 0; step < 4; step++) {
    const receiveLabel = await clickExactReceiveText();
    if (receiveLabel) {
      clickedLabels.push(receiveLabel);
      await page.waitForTimeout(2500);
      continue;
    }

    const candidates = page.locator('button, [role="button"], a');
    const count = Math.min(await candidates.count(), 300);
    let clickedThisStep = false;
    for (let i = 0; i < count; i++) {
      const item = candidates.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      const text = (await item.innerText().catch(() => '')).trim();
      const aria = ((await item.getAttribute('aria-label').catch(() => '')) || '').trim();
      const label = text || aria;
      if (!patterns.some((p) => p.test(text) || p.test(aria))) continue;
      if (/history|내역|shop|store|상품|구매/i.test(`${text} ${aria}`)) continue;
      writeLog(`출석 단계 ${step + 1} 클릭: ${JSON.stringify(label.slice(0, 80))}`);
      const didClick = await item.click({ timeout: 5000 }).then(() => true).catch(() => false);
      if (!didClick) continue;
      clickedLabels.push(label);
      clickedThisStep = true;
      await page.waitForTimeout(2500);
      break;
    }
    if (!clickedThisStep) break;
  }
  return clickedLabels;
}

async function main() {
  if (mode === 'run' && process.env.ALIEXPRESS_FORCE !== '1') {
    const state = readState();
    const currentWindow = attendanceWindowKey();
    if (state.completedWindow === currentWindow) {
      writeLog(`RESULT=ALREADY_DONE 출석 회차 ${currentWindow}는 이미 처리했습니다.`);
      return;
    }
  }

  const executablePath = process.env.ALIEXPRESS_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const context = await chromium.launchPersistentContext(PROFILE, {
    executablePath,
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    args: ['--disable-blink-features=AutomationControlled']
  });
  const page = context.pages()[0] || await context.newPage();

  try {
    if (mode === 'login') {
      writeLog('로그인 준비 모드 시작');
      await page.goto('https://login.aliexpress.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('\n브라우저에서 직접 로그인한 뒤 이 창으로 돌아와 Enter를 누르세요.');
      await new Promise((resolve) => process.stdin.once('data', resolve));
      await page.goto(coinUrls[0], { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
      await page.waitForTimeout(5000);
      await page.screenshot({ path: path.join(SHOTS, `${stamp()}-login-ready.png`), fullPage: true });
      writeLog('로그인 프로필 저장 완료');
      return;
    }

    let opened = false;
    for (const url of coinUrls) {
      writeLog(`코인 페이지 열기: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => writeLog(`페이지 오류: ${e.message}`));
      await page.waitForTimeout(7000);
      if (await pageLooksLoggedOut(page)) {
        writeLog('RESULT=LOGIN_REQUIRED 로그인 갱신 필요');
        await page.screenshot({ path: path.join(SHOTS, `${stamp()}-login-required.png`), fullPage: true }).catch(() => null);
        process.exitCode = 2;
        return;
      }
      if (await hasSecurityChallenge(page)) {
        writeLog('RESULT=VERIFICATION_REQUIRED 보안 확인 필요');
        await page.screenshot({ path: path.join(SHOTS, `${stamp()}-verification.png`), fullPage: true }).catch(() => null);
        process.exitCode = 3;
        return;
      }
      const body = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
      if (/coin|코인|동전|金币/i.test(body)) {
        opened = true;
        const clicked = await tryCheckIn(page);
        await page.screenshot({ path: path.join(SHOTS, `${stamp()}-${clicked.length ? 'clicked' : 'visited'}.png`), fullPage: true });
        const result = clicked.length ? `RESULT=SUCCESS 출석/받기 버튼 ${clicked.length}개를 처리했습니다: ${clicked.join(' -> ')}` : 'RESULT=VISITED 코인 페이지를 열었습니다. 이미 출석했거나 방문 즉시 처리되었을 수 있습니다.';
        writeLog(result);
        markWindowDone(clicked.length ? 'SUCCESS' : 'VISITED');
        return;
      }
    }
    if (!opened) {
      await page.screenshot({ path: path.join(SHOTS, `${stamp()}-not-found.png`), fullPage: true }).catch(() => null);
      writeLog('RESULT=PAGE_NOT_FOUND 코인 화면을 찾지 못했습니다.');
      process.exitCode = 4;
    }
  } finally {
    if (headed && mode !== 'login') await page.waitForTimeout(4000).catch(() => null);
    await context.close();
  }
}

main().catch((error) => {
  writeLog(`RESULT=ERROR ${error.stack || error.message}`);
  process.exitCode = 1;
});
