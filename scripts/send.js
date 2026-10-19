'use strict';
/**
 * 예약된 공지를 찾아 대상 근무자의 기기로 푸시 알림을 보내는 스크립트.
 * GitHub Actions(.github/workflows/notify.yml)가 5분마다 실행합니다.
 *
 * Firestore 구조
 *   announcements/{id} : { date:'YYYY-MM-DD', time:'HH:MM', targets:[이름...], title, message,
 *                          author, createdAt, status:'pending'|'sent'|'expired',
 *                          (발송 후) sentAt, sentCount, failCount, missing:[알림 미설정 이름...] }
 *   tokens/{uid}       : { name, token, updatedAt }   // 기기 1대 = 문서 1개
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;   // 예정 시각보다 24시간 넘게 지난 공지는 보내지 않고 만료 처리
const KEEP_DAYS = 60;                          // 이 기간이 지난 공지는 자동 삭제
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

function kstDateStr(ms) {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

async function run({ db, messaging, now = Date.now(), log = console.log }) {
  const annCol = db.collection('announcements');

  // 1) 보낼 시각이 된 공지 찾기
  const pendingSnap = await annCol.where('status', '==', 'pending').get();
  const due = [];
  for (const docSnap of pendingSnap.docs) {
    const a = docSnap.data();
    const when = Date.parse(`${a.date}T${a.time}:00+09:00`);
    if (Number.isNaN(when)) {
      await docSnap.ref.update({ status: 'expired', note: 'invalid-datetime' });
      continue;
    }
    if (when > now) continue;                       // 아직 시각이 안 됨
    if (now - when > EXPIRE_AFTER_MS) {             // 너무 오래 지남
      await docSnap.ref.update({ status: 'expired' });
      log(`[만료] ${docSnap.id} (${a.date} ${a.time})`);
      continue;
    }
    due.push(docSnap);
  }

  const summary = { due: due.length, sent: 0, failed: 0, deleted: 0 };

  if (due.length === 0) {
    log('보낼 공지가 없습니다.');
  } else {
    // 2) 기기 토큰을 이름별로 정리
    const tokenSnap = await db.collection('tokens').get();
    const byName = new Map();
    for (const t of tokenSnap.docs) {
      const { name, token } = t.data();
      if (!name || !token) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ ref: t.ref, token });
    }

    // 3) 공지별 발송
    for (const docSnap of due) {
      const a = docSnap.data();
      const names = Array.isArray(a.targets) ? a.targets : [];
      const entries = [];
      const missing = [];
      for (const n of names) {
        const list = byName.get(n);
        if (list && list.length) entries.push(...list);
        else missing.push(n);
      }
      const tokens = [...new Set(entries.map((e) => e.token))];

      let success = 0;
      let failure = 0;
      const dead = new Set();
      try {
        for (let i = 0; i < tokens.length; i += 500) {
          const chunk = tokens.slice(i, i + 500);
          const res = await messaging.sendEachForMulticast({
            tokens: chunk,
            data: {                       // 데이터 전용 메시지: 표시는 sw.js의 push 핸들러가 담당
              title: String(a.title || '기술국 근무 공지'),
              body: String(a.message || ''),
              tag: docSnap.id,
            },
            webpush: { headers: { Urgency: 'high', TTL: '86400' } },
          });
          res.responses.forEach((r, idx) => {
            if (r.success) {
              success++;
            } else {
              failure++;
              const code = r.error && r.error.code;
              if (DEAD_TOKEN_CODES.has(code)) dead.add(chunk[idx]);
              else log(`  전송 실패(${code || 'unknown'}): ${a.title || a.message}`);
            }
          });
        }
      } catch (err) {
        // 서버/네트워크 오류: 'pending'으로 남겨 두어 다음 실행 때 다시 시도
        log(`[오류] ${docSnap.id} 발송 중 예외, 다음 실행에서 재시도: ${err.message}`);
        summary.failed++;
        continue;
      }

      // 만료된 토큰 정리
      for (const e of entries) {
        if (dead.has(e.token)) { await e.ref.delete(); summary.deleted++; }
      }

      await docSnap.ref.update({
        status: 'sent',
        sentAt: new Date(now),
        sentCount: success,
        failCount: failure,
        missing,
      });
      summary.sent++;
      log(`[발송] ${a.date} ${a.time} → 대상 ${names.length}명, 기기 ${success}대 성공/${failure}대 실패` +
          (missing.length ? `, 알림 미설정: ${missing.join(', ')}` : ''));
    }
  }

  // 4) 오래된 공지 정리
  const cutoff = kstDateStr(now - KEEP_DAYS * 24 * 60 * 60 * 1000);
  const oldSnap = await annCol.where('date', '<', cutoff).get();
  if (!oldSnap.empty) {
    const batch = db.batch();
    oldSnap.docs.slice(0, 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
    log(`[정리] ${Math.min(oldSnap.size, 400)}건의 오래된 공지를 삭제했습니다.`);
  }

  return summary;
}

module.exports = { run };

if (require.main === module) {
  const admin = require('firebase-admin');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error('FIREBASE_SERVICE_ACCOUNT 환경변수(GitHub Secret)가 없습니다.');
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  run({ db: admin.firestore(), messaging: admin.messaging() })
    .then((s) => console.log('완료', JSON.stringify(s)))
    .catch((e) => { console.error(e); process.exit(1); });
}
