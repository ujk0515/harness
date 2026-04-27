#!/usr/bin/env node
/**
 * cycle-rotate.js
 *
 * Usage:
 *   node .claude/scripts/cycle-rotate.js
 *
 * 동작:
 *   workspace/cycles/ 안의 .md 파일이 10개를 초과하면
 *   파일명 timestamp(YYYYMMDD-HHMM) 기준 가장 오래된 것부터 제거한다.
 *   사용자 확인 없이 직접 삭제한다 (hook 권한으로 실행되는 정리 작업).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CYCLES_DIR = path.join(ROOT, 'workspace', 'cycles');
const LIMIT = 10;

function extractStamp(filename) {
  // 패턴: {batch_id}_{YYYYMMDD-HHMM}.md
  const m = filename.match(/_(\d{8}-\d{4})\.md$/);
  return m ? m[1] : '';
}

function isActive(fullPath) {
  // 본문 헤더에 `종료일시: (미정)` 가 있으면 진행 중으로 보고 보존한다.
  try {
    const head = fs.readFileSync(fullPath, 'utf8').slice(0, 512);
    return /종료일시:\s*\(미정\)/.test(head);
  } catch {
    return false;
  }
}

function main() {
  if (!fs.existsSync(CYCLES_DIR)) return;

  const files = fs
    .readdirSync(CYCLES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: f, stamp: extractStamp(f) }))
    .filter((f) => f.stamp) // 형식 안 맞는 파일은 건드리지 않음
    .sort((a, b) => a.stamp.localeCompare(b.stamp));

  // 활성(미정) 파일은 정리 후보에서 제외 → 진행 중 batch 보호
  const removable = files.filter((f) => !isActive(path.join(CYCLES_DIR, f.name)));
  const overflow = files.length - LIMIT;
  if (overflow <= 0) return;

  let removed = 0;
  for (const f of removable) {
    if (removed >= overflow) break;
    const target = path.join(CYCLES_DIR, f.name);
    try {
      fs.unlinkSync(target);
      process.stdout.write(`[cycle-rotate] removed ${f.name}\n`);
      removed += 1;
    } catch (e) {
      process.stderr.write(`[cycle-rotate] skip ${f.name}: ${e.message}\n`);
    }
  }
  if (removed < overflow) {
    process.stderr.write(`[cycle-rotate] ${overflow - removed} active file(s) kept beyond limit\n`);
  }
}

main();
