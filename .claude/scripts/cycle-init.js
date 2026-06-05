#!/usr/bin/env node
/**
 * cycle-init.js
 *
 * Usage:
 *   node .claude/scripts/cycle-init.js <batch_id> [title]
 *   node .claude/scripts/cycle-init.js --update <path>
 *
 * 동작:
 *   1) workspace/cycles/{batch_id}_{YYYYMMDD-HHMM}.md 가 이미 있으면 그 경로만 출력.
 *   2) 없으면 새로 생성하면서 헤더 + 6개 섹션 + 코멘트 영역 골격을 박아넣는다.
 *   3) 종료 시 cycle-rotate.js 를 호출해 폴더 한도(10개) 정리.
 *   4) --update <path>: 헤더의 종료일시를 현재 시각으로, 참여 에이전트를
 *      실제 채워진 섹션 기준으로 갱신한다 (batch 종료 시 메인 하네스가 1회 호출).
 *
 * 헤더 형식은 사람이 손대지 않는다. 갱신은 update 모드(`--update <path>`)로만.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CYCLES_DIR = path.join(ROOT, 'workspace', 'cycles');
const ROTATE_SCRIPT = path.join(__dirname, 'cycle-rotate.js');

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function nowLocalReadable() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function findExisting(batchId) {
  if (!fs.existsSync(CYCLES_DIR)) return null;
  const prefix = `${batchId}_`;
  const matches = fs
    .readdirSync(CYCLES_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
    .sort();
  if (matches.length === 0) return null;
  return path.join(CYCLES_DIR, matches[matches.length - 1]);
}

function buildSkeleton({ batchId, title, stamp, createdAt }) {
  return `# ${batchId} ${title || ''}

<!-- 헤더는 hook 스크립트가 관리합니다. 사람이 손으로 형식을 바꾸지 마세요. -->
- batch_id: ${batchId}
- 생성일시: ${createdAt}
- 종료일시: (미정)
- 참여 에이전트: (auto)

## [Planner]
_(planner가 채움)_

## [Developer]
_(developer가 채움)_

## [QA]
_(qa가 채움)_

## [Tester]
_(tester가 채움)_

## [Secretary]
_(secretary가 채움)_

## [코멘트/이슈]
- 형식: \`- [{보낸이}→{받는이}] (open|resolved) {YYYY-MM-DD HH:MM} 내용\`
`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rotate() {
  try {
    execFileSync('node', [ROTATE_SCRIPT], { stdio: 'inherit' });
  } catch (e) {
    process.stderr.write(`[cycle-init] rotate skipped: ${e.message}\n`);
  }
}

function updateHeader(filePath) {
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`[cycle-init] not found: ${filePath}\n`);
    process.exit(1);
  }
  let body = fs.readFileSync(filePath, 'utf8');
  body = body.replace(/^- 종료일시: .*$/m, `- 종료일시: ${nowLocalReadable()}`);

  // 참여 에이전트: placeholder(`_(...가 채움)_`)가 아닌 섹션만 집계
  const roles = ['Planner', 'Developer', 'QA', 'Tester', 'Secretary'];
  const filled = roles.filter((role) => {
    const m = body.match(new RegExp(`## \\[${role}\\]\\n([\\s\\S]*?)(?=\\n## \\[|$)`));
    if (!m) return false;
    const content = m[1].trim();
    return content.length > 0 && !content.startsWith('_(');
  });
  body = body.replace(
    /^- 참여 에이전트: .*$/m,
    `- 참여 에이전트: ${filled.length ? filled.map((r) => r.toLowerCase()).join(', ') : '(없음)'}`
  );

  fs.writeFileSync(filePath, body, 'utf8');
  process.stdout.write(filePath + '\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('Usage: cycle-init.js <batch_id> [title] | --update <path>\n');
    process.exit(1);
  }
  if (args[0] === '--update') {
    if (!args[1]) {
      process.stderr.write('Usage: cycle-init.js --update <path>\n');
      process.exit(1);
    }
    updateHeader(path.resolve(args[1]));
    return;
  }
  const [batchId, ...rest] = args;
  const title = rest.join(' ').trim();

  ensureDir(CYCLES_DIR);

  const existing = findExisting(batchId);
  if (existing) {
    process.stdout.write(existing + '\n');
    return;
  }

  const stamp = nowStamp();
  const filename = `${batchId}_${stamp}.md`;
  const fullPath = path.join(CYCLES_DIR, filename);
  const createdAt = nowLocalReadable();
  const body = buildSkeleton({ batchId, title, stamp, createdAt });
  fs.writeFileSync(fullPath, body, 'utf8');
  process.stdout.write(fullPath + '\n');

  rotate();
}

main();
