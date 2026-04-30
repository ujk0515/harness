#!/usr/bin/env node
/**
 * cycle-init.js
 *
 * Usage:
 *   node .claude/scripts/cycle-init.js <batch_id> [title]
 *
 * 동작:
 *   1) workspace/cycles/{batch_id}_{YYYYMMDD-HHMM}.md 가 이미 있으면 그 경로만 출력.
 *   2) 없으면 새로 생성하면서 헤더 + 6개 섹션 + 코멘트 영역 골격을 박아넣는다.
 *   3) 종료 시 cycle-rotate.js 를 호출해 폴더 한도(10개) 정리.
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

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('Usage: cycle-init.js <batch_id> [title]\n');
    process.exit(1);
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
