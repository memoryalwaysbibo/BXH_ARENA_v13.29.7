"use strict";
const {randomUUID} = require('node:crypto');

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {setGlobalOptions} = require("firebase-functions/v2");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue, FieldPath, Timestamp} = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();
const REGION = "asia-east1";
setGlobalOptions({region: REGION, maxInstances: 5});
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const ALLOWED_TITLE_FORMATS = new Set([
  "realname_nickname_title",
  "realname_dash_nickname_title",
  "realname_title",
  "nickname_title",
]);
const DEFAULT_SETTINGS = Object.freeze({
  titlesEnabled: false,
  automaticTitleAwardsEnabled: false,
  dailyCheckInEnabled: false,
  checkInTitleAwardsEnabled: false,
  timezone: "Asia/Taipei",
  launchAt: null,
});

function taipeiDateKey(date = new Date()) {
  return new Date(date.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}
function previousDateKey(key) {
  return new Date(Date.parse(`${key}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
function monthKey(key) {
  return String(key || "").slice(0, 7);
}
function currentCheckInStats(stats, today) {
  return Object.assign({}, stats, {
    monthlyCheckInDays: monthKey(stats.lastCheckInDate) === monthKey(today) ? Number(stats.monthlyCheckInDays || 0) : 0,
    currentCheckInStreak: [today, previousDateKey(today)].includes(stats.lastCheckInDate) ? Number(stats.currentCheckInStreak || 0) : 0,
  });
}
function dateKeysThroughToday(days, today = taipeiDateKey()) {
  const keys = [];
  let cursor = today;
  for (let i = 0; i < days; i += 1) {
    keys.unshift(cursor);
    cursor = previousDateKey(cursor);
  }
  return keys;
}
function safeId(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}
function validDocumentId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);
}
function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function serializeValue(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeValue(v)]));
  }
  return value;
}
async function settings() {
  const snap = await db.doc("systemSettings/engagement").get();
  return Object.assign({}, DEFAULT_SETTINGS, snap.exists ? snap.data() : {});
}
async function requireActiveUser(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError("unauthenticated", "auth-required");
  const ref = db.doc(`users/${request.auth.uid}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data().active !== true) throw new HttpsError("permission-denied", "inactive-account");
  return {uid: request.auth.uid, ref, data: snap.data()};
}
async function requireSuperAdmin(request) {
  const actor = await requireActiveUser(request);
  if (actor.data.role !== "super_admin") throw new HttpsError("permission-denied", "super-admin-required");
  return actor;
}
function activeWindow(definition, now = Date.now()) {
  const from = timestampMillis(definition.availableFrom);
  const until = timestampMillis(definition.availableUntil);
  return (!from || now >= from) && (!until || now <= until);
}
function publicDefinition(id, definition) {
  const hidden = definition.isHidden === true;
  return {
    id,
    code: hidden ? "hidden" : String(definition.code || id),
    name: hidden ? "？？？" : String(definition.name || id),
    description: hidden ? "達成特殊條件後解鎖" : String(definition.description || ""),
    hint: String(definition.hint || ""),
    category: String(definition.category || "achievement"),
    rarity: String(definition.rarity || "common"),
    targetValue: Math.max(1, Number(definition.targetValue || 1)),
    isPublic: definition.isPublic !== false,
    isHidden: hidden,
    isLimited: definition.isLimited === true,
    isPermanent: definition.isPermanent !== false,
    isActive: definition.isActive === true,
    isArchived: definition.isArchived === true,
    availableFrom: definition.availableFrom || null,
    availableUntil: definition.availableUntil || null,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function conditionProgress(definition, stats) {
  switch (definition.conditionType) {
    case "completed_tournaments": return Number(stats.completedTournamentCount || 0);
    case "championships": return Number(stats.championshipCount || 0);
    case "best_placement": {
      const best = Number(stats.bestPlacement || 0);
      const target = Number(definition.targetValue || 1);
      return best > 0 && best <= target ? target : 0;
    }
    case "total_checkins": return Number(stats.totalCheckInDays || 0);
    case "checkin_streak": return Number(stats.currentCheckInStreak || 0);
    default: return 0;
  }
}

async function awardTitle({uid, titleId, sourceType, sourceId, seasonId = null, grantedBy = "system", grantReason = ""}) {
  if (!validDocumentId(uid) || !validDocumentId(titleId)) return {awarded: false, reason: "invalid-target"};
  const defRef = db.doc(`titleDefinitions/${titleId}`);
  const earnedRef = db.doc(`users/${uid}/earnedTitles/${titleId}`);
  const targetUserRef = db.doc(`users/${uid}`);
  const counterRef = db.doc(`titleCounters/${titleId}`);
  const operationId = safeId(`${uid}_${titleId}_${sourceType}_${sourceId || "none"}`);
  const auditRef = db.doc(`titleAuditLogs/${operationId}`);
  return db.runTransaction(async (tx) => {
    const [defSnap, earnedSnap, targetUserSnap] = await Promise.all([
      tx.get(defRef), tx.get(earnedRef), tx.get(targetUserRef),
    ]);
    if (!defSnap.exists) return {awarded: false, reason: "definition-missing"};
    const def = defSnap.data();
    if (def.isActive !== true || !activeWindow(def)) return {awarded: false, reason: "inactive"};
    if (!targetUserSnap.exists || targetUserSnap.data().active !== true) return {awarded: false, reason: "target-inactive"};
    if (earnedSnap.exists) return {awarded: false, reason: "already-earned"};
    const isTestData = targetUserSnap.data().role === "tester";
    const maxRecipients = Math.max(0, Number(def.maxRecipients || 0));
    let recipientNumber = null;
    if (!isTestData && maxRecipients > 0) {
      const counterSnap = await tx.get(counterRef);
      const count = counterSnap.exists ? Number(counterSnap.data().recipientCount || 0) : 0;
      if (count >= maxRecipients) return {awarded: false, reason: "quota-full"};
      recipientNumber = count + 1;
      tx.set(counterRef, {recipientCount: recipientNumber, maxRecipients, updatedAt: FieldValue.serverTimestamp()}, {merge: true});
    }
    tx.create(earnedRef, {
      titleId,
      status: "active",
      earnedAt: FieldValue.serverTimestamp(),
      sourceType,
      sourceId: sourceId || null,
      seasonId,
      progressAtUnlock: Number(def.targetValue || 1),
      grantedBy,
      grantReason: grantReason || null,
      recipientNumber,
      definitionVersionAtUnlock: Number(def.version || 1),
      isTestData,
    });
    tx.set(auditRef, {
      action: "grant",
      operationId,
      titleId,
      targetUid: uid,
      operatorUid: grantedBy,
      sourceType,
      sourceId: sourceId || null,
      reason: grantReason || null,
      isTestData,
      createdAt: FieldValue.serverTimestamp(),
    });
    if (!isTestData) tx.set(defRef, {recipientCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp()}, {merge: true});
    return {awarded: true, recipientNumber};
  });
}

async function evaluateTitles(uid, sourceType, sourceId) {
  const cfg = await settings();
  if (cfg.titlesEnabled !== true) return [];
  if (sourceType !== "historical_backfill" && cfg.automaticTitleAwardsEnabled !== true) return [];
  const statsSnap = await db.doc(`playerStats/${uid}`).get();
  const stats = statsSnap.exists ? statsSnap.data() : {};
  const defs = await db.collection("titleDefinitions").where("isActive", "==", true).get();
  const results = [];
  for (const doc of defs.docs) {
    try {
      const def = doc.data();
      if (sourceType === "historical_backfill" && def.retroactiveEnabled !== true) continue;
      const isCheckIn = ["total_checkins", "checkin_streak"].includes(def.conditionType);
      if (isCheckIn && cfg.checkInTitleAwardsEnabled !== true) continue;
      const currentValue = conditionProgress(def, stats);
      const targetValue = Math.max(1, Number(def.targetValue || 1));
      await db.doc(`users/${uid}/titleProgress/${doc.id}`).set({
        titleId: doc.id,
        currentValue,
        targetValue,
        completed: currentValue >= targetValue,
        updatedAt: FieldValue.serverTimestamp(),
      }, {merge: true});
      if (currentValue >= targetValue) {
        results.push(Object.assign({titleId: doc.id}, await awardTitle({uid, titleId: doc.id, sourceType, sourceId, grantedBy: "system"})));
      }
    } catch (error) {
      console.error("BXH title evaluation failed", {uid, titleId: doc.id, sourceType, code: error && error.code, message: error && error.message});
      results.push({titleId: doc.id, awarded: false, reason: "evaluation-error"});
    }
  }
  return results;
}

exports.getEngagementSnapshot = onCall({region: REGION, cors: true}, async (request) => {
  const actor = await requireActiveUser(request);
  const cfg = await settings();
  const today = taipeiDateKey();
  const [catalogSnap, earnedSnap, progressSnap, statsSnap, todaySnap, freshProfile, monthSnap] = await Promise.all([
    db.collection("publicTitleCatalog").where("isPublic", "==", true).get(),
    db.collection(`users/${actor.uid}/earnedTitles`).get(),
    db.collection(`users/${actor.uid}/titleProgress`).get(),
    db.doc(`playerStats/${actor.uid}`).get(),
    db.doc(`users/${actor.uid}/dailyCheckIns/${today}`).get(),
    actor.ref.get(),
    db.collection(`users/${actor.uid}/dailyCheckIns`).orderBy(FieldPath.documentId()).startAt(`${monthKey(today)}-01`).endAt(today).limit(31).get(),
  ]);
  const earned = earnedSnap.docs.filter((d) => d.data().status !== "revoked").map((d) => serializeValue(Object.assign({titleId: d.id}, d.data())));
  const earnedIds = new Set(earned.map((item) => item.titleId));
  const privateEarnedDefinitions = new Map();
  await Promise.all([...earnedIds].map(async (titleId) => {
    const snap = await db.doc(`titleDefinitions/${titleId}`).get();
    if (snap.exists) privateEarnedDefinitions.set(titleId, serializeValue(snap.data()));
  }));
  const progress = new Map(progressSnap.docs.map((d) => [d.id, serializeValue(d.data())]));
  const catalog = catalogSnap.docs.map((d) => {
    const safe = serializeValue(d.data());
    let visible = safe;
    if (earnedIds.has(d.id) && privateEarnedDefinitions.has(d.id)) {
      const full = privateEarnedDefinitions.get(d.id);
      visible = Object.assign({}, safe, {code: full.code, name: full.name, description: full.description, hint: full.hint});
    }
    return Object.assign({id: d.id, progress: progress.get(d.id) || null}, visible);
  });
  const profile = freshProfile.data() || {};
  return {
    ok: true,
    settings: {
      titlesEnabled: cfg.titlesEnabled === true,
      automaticTitleAwardsEnabled: cfg.automaticTitleAwardsEnabled === true,
      dailyCheckInEnabled: cfg.dailyCheckInEnabled === true,
      checkInTitleAwardsEnabled: cfg.checkInTitleAwardsEnabled === true,
      timezone: "Asia/Taipei",
    },
    catalog,
    earned,
    stats: serializeValue(currentCheckInStats(statsSnap.exists ? statsSnap.data() : {}, today)),
    checkIn: {today, checkedIn: todaySnap.exists, month: monthKey(today), dates: monthSnap.docs.map(doc => doc.id)},
    serverTime: Date.now(),
    serviceVersion: "13.29.4",
    profilePatch: {
      equippedTitleId: profile.equippedTitleId || "",
      titleDisplayEnabled: profile.titleDisplayEnabled !== false,
      titleDisplayFormat: profile.titleDisplayFormat || "realname_nickname_title",
    },
  };
});

exports.dailyCheckIn = onCall({region: REGION, cors: true}, async (request) => {
  const actor = await requireActiveUser(request);
  const cfg = await settings();
  if (cfg.dailyCheckInEnabled !== true) throw new HttpsError("failed-precondition", "feature-disabled");
  const today = taipeiDateKey();
  const yesterday = previousDateKey(today);
  const checkInRef = db.doc(`users/${actor.uid}/dailyCheckIns/${today}`);
  const statsRef = db.doc(`playerStats/${actor.uid}`);
  const dailyStatsRef = db.doc(`engagementDailyStats/${today}`);
  const result = await db.runTransaction(async (tx) => {
    const [checkInSnap, statsSnap, dailyStatsSnap] = await Promise.all([tx.get(checkInRef), tx.get(statsRef), tx.get(dailyStatsRef)]);
    if (checkInSnap.exists) return {alreadyCheckedIn: true, stats: statsSnap.exists ? statsSnap.data() : {}};
    const old = statsSnap.exists ? statsSnap.data() : {};
    const consecutive = old.lastCheckInDate === yesterday ? Number(old.currentCheckInStreak || 0) + 1 : 1;
    const total = Number(old.totalCheckInDays || 0) + 1;
    const monthly = monthKey(old.lastCheckInDate) === monthKey(today) ? Number(old.monthlyCheckInDays || 0) + 1 : 1;
    const next = {
      uid: actor.uid,
      totalCheckInDays: total,
      currentCheckInStreak: consecutive,
      highestCheckInStreak: Math.max(Number(old.highestCheckInStreak || 0), consecutive),
      monthlyCheckInDays: monthly,
      lastCheckInDate: today,
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.create(checkInRef, {
      checkInDate: today,
      checkInAt: FieldValue.serverTimestamp(),
      timezone: "Asia/Taipei",
      source: "player_action",
      operationId: `${actor.uid}_${today}`,
      isTestData: actor.data.role === "tester",
    });
    tx.set(statsRef, next, {merge: true});
    const daily = dailyStatsSnap.exists ? dailyStatsSnap.data() : {};
    tx.set(dailyStatsRef, {
      dateKey: today,
      totalCount: Number(daily.totalCount || 0) + 1,
      officialCount: Number(daily.officialCount || 0) + (actor.data.role === "tester" ? 0 : 1),
      testCount: Number(daily.testCount || 0) + (actor.data.role === "tester" ? 1 : 0),
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true});
    return {alreadyCheckedIn: false, stats: next};
  });
  let titleEvaluationWarning = false;
  if (actor.data.role !== "tester") {
    try {
      const titleResults = await evaluateTitles(actor.uid, "daily_checkin", today);
      titleEvaluationWarning = titleResults.some((item) => item && item.reason === "evaluation-error");
    } catch (error) {
      console.error("checkin-award-pending", {uid: actor.uid, code: error.code});
      titleEvaluationWarning = true;
    }
  }
  // 簽到交易一旦成功就必須回報成功；個別稱號判定異常不可讓玩家誤以為
  // 簽到失敗而重複操作。警示交由前端提示稍後補發。
  return {ok: true, alreadyCheckedIn: result.alreadyCheckedIn, today, stats: serializeValue(result.stats), titleEvaluationWarning};
});

exports.setTitlePreferences = onCall({region: REGION, cors: true}, async (request) => {
  const actor = await requireActiveUser(request);
  const cfg = await settings();
  if (cfg.titlesEnabled !== true) throw new HttpsError("failed-precondition", "feature-disabled");
  const data = request.data || {};
  const titleId = String(data.equippedTitleId || "").trim();
  const enabled = data.titleDisplayEnabled === true;
  const format = ALLOWED_TITLE_FORMATS.has(data.titleDisplayFormat) ? data.titleDisplayFormat : "realname_nickname_title";
  if (titleId && !validDocumentId(titleId)) throw new HttpsError("invalid-argument", "invalid-title-id");
  if (titleId) {
    const [earned, definition] = await Promise.all([
      db.doc(`users/${actor.uid}/earnedTitles/${titleId}`).get(),
      db.doc(`titleDefinitions/${titleId}`).get(),
    ]);
    if (!earned.exists || earned.data().status === "revoked") throw new HttpsError("permission-denied", "title-not-earned");
    if (!definition.exists || definition.data().isActive !== true) throw new HttpsError("failed-precondition", "title-inactive");
  }
  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.set(actor.ref, {equippedTitleId: titleId || null, titleDisplayEnabled: enabled, titleDisplayFormat: format, updatedAt: now}, {merge: true});
  batch.set(db.doc(`publicPlayers/${actor.uid}`), {
    publicName: String(actor.data.gameId || actor.data.nickname || actor.data.displayName || actor.data.realName || ""),
    avatarUrl: actor.data.avatarUrl || null,
    equippedTitleId: enabled && titleId ? titleId : null,
    titleDisplayEnabled: enabled,
    titleDisplayFormat: format,
    updatedAt: Date.now(),
  }, {merge: true});
  await batch.commit();
  return {ok: true, equippedTitleId: titleId, titleDisplayEnabled: enabled, titleDisplayFormat: format};
});

async function processOfficialEventLog(log, sourceLogId, sourceType = "official_tournament", dryRun = false) {
  if (!log || log.type !== "event" || !log.playerUid || !log.eventCode) return {status: "skipped", reason: "not-event"};
  const tourSnap = await db.doc(`tournaments/${String(log.eventCode).toUpperCase()}`).get();
  if (!tourSnap.exists) return {status: "skipped", reason: "tournament-missing"};
  const tour = tourSnap.data();
  if (tour.eventAuthority !== "official" || tour.ladderMode !== "ranked" || tour.testMode === true || tour.eventCancelled === true || tour.ladderPointsAwarded !== true) return {status: "skipped", reason: "not-eligible-official-event"};
  const uid = String(log.playerUid);
  if (!validDocumentId(uid)) return {status: "skipped", reason: "invalid-player-uid"};
  const playerSnap = await db.doc(`users/${uid}`).get();
  if (!playerSnap.exists) return {status: "skipped", reason: "player-missing"};
  if (playerSnap.data().role === "tester") return {status: "skipped", reason: "tester-account"};
  const eventCode = String(log.eventCode).toUpperCase();
  const resultRef = db.doc(`playerEventResults/${safeId(`${eventCode}_${uid}`)}`);
  const statsRef = db.doc(`playerStats/${uid}`);
  if (dryRun) {
    const exists = await resultRef.get();
    return {status: "eligible", reason: exists.exists ? "titles-only-reevaluation" : null, alreadyProcessed: exists.exists, uid, eventCode};
  }
  const created = await db.runTransaction(async (tx) => {
    const [resultSnap, statsSnap] = await Promise.all([tx.get(resultRef), tx.get(statsRef)]);
    if (resultSnap.exists) return false;
    const old = statsSnap.exists ? statsSnap.data() : {};
    const placement = Number(log.placement || 0) || null;
    const championships = Number(old.championshipCount || 0) + (placement === 1 ? 1 : 0);
    const oldBest = Number(old.bestPlacement || 0);
    const bestPlacement = placement ? (oldBest ? Math.min(oldBest, placement) : placement) : oldBest || null;
    tx.create(resultRef, {
      eventCode,
      playerUid: uid,
      playerName: String(log.playerName || ""),
      seasonId: log.seasonId || null,
      venueId: tour.venueId || null,
      placement,
      stageReached: placement && placement <= 4 ? "top4" : null,
      wins: Number.isFinite(Number(log.wins)) ? Number(log.wins) : null,
      losses: Number.isFinite(Number(log.losses)) ? Number(log.losses) : null,
      participated: true,
      authority: "official",
      ladderMode: "ranked",
      completedAt: tour.completedAt || tour.ladderAwardedAt || FieldValue.serverTimestamp(),
      sourceLogId,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(statsRef, {
      uid,
      completedTournamentCount: Number(old.completedTournamentCount || 0) + 1,
      championshipCount: championships,
      bestPlacement,
      updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true});
    return true;
  });
  // 即使前一次觸發已完成統計、但稱號判定暫時失敗，重試時仍會再次執行
  // 冪等的稱號判定；不可因 result 文件已存在就永遠跳過補發。
  const awards = await evaluateTitles(uid, sourceType, eventCode);
  return {status: created ? "created" : "processed", uid, eventCode,
    awarded: awards.filter(item => item.awarded).length,
    awardErrors: awards.filter(item => item.reason === "evaluation-error").length};
}

exports.onLadderTransactionCreated = onDocumentCreated({document: "ladderTransactions/{logId}", region: REGION}, async (event) => {
  const log = event.data && event.data.data();
  await processOfficialEventLog(log, event.params.logId, "official_tournament", false);
});

exports.getEngagementAdminOverview = onCall({region: REGION, cors: true}, async (request) => {
  await requireSuperAdmin(request);
  const today = taipeiDateKey();
  const keys = dateKeysThroughToday(31, today);
  const [dailySnaps, topStats, statsSample, runSnaps, definitions] = await Promise.all([
    db.getAll(...keys.map((key) => db.doc(`engagementDailyStats/${key}`))),
    db.collection("playerStats").orderBy("highestCheckInStreak", "desc").limit(10).get(),
    db.collection("playerStats").limit(250).get(),
    db.collection("titleBackfillRuns").orderBy("createdAt", "desc").limit(10).get(),
    db.collection("titleDefinitions").get(),
  ]);
  const daily = dailySnaps.map((snap, index) => Object.assign({dateKey: keys[index], totalCount: 0, officialCount: 0, testCount: 0}, snap.exists ? serializeValue(snap.data()) : {}));
  const weekKeys = new Set(keys.slice(-7));
  const month = monthKey(today);
  const sum = (rows) => rows.reduce((acc, row) => ({
    totalCount: acc.totalCount + Number(row.totalCount || 0),
    officialCount: acc.officialCount + Number(row.officialCount || 0),
    testCount: acc.testCount + Number(row.testCount || 0),
  }), {totalCount: 0, officialCount: 0, testCount: 0});
  const anomalies = [];
  for (const doc of statsSample.docs) {
    const value = doc.data();
    const reasons = [];
    const total = Number(value.totalCheckInDays || 0);
    const current = Number(value.currentCheckInStreak || 0);
    const highest = Number(value.highestCheckInStreak || 0);
    const monthly = Number(value.monthlyCheckInDays || 0);
    if ([total, current, highest, monthly].some((n) => !Number.isFinite(n) || n < 0)) reasons.push("invalid-count");
    if (current > highest) reasons.push("current-over-highest");
    if (monthly > total) reasons.push("monthly-over-total");
    if (value.lastCheckInDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(value.lastCheckInDate))) reasons.push("invalid-last-date");
    if (reasons.length) anomalies.push({uid: doc.id, reasons});
  }
  const topUsers = topStats.empty ? [] : await db.getAll(...topStats.docs.map((doc) => db.doc(`users/${doc.id}`)));
  return {
    ok: true,
    today,
    daily,
    todaySummary: daily[daily.length - 1],
    weekSummary: sum(daily.filter((row) => weekKeys.has(row.dateKey))),
    monthSummary: sum(daily.filter((row) => monthKey(row.dateKey) === month)),
    topStreaks: topStats.docs.map((doc, index) => ({uid: doc.id, isTestData: (topUsers[index].data() || {}).role === 'tester', name: String((topUsers[index].data() || {}).realName || (topUsers[index].data() || {}).displayName || doc.id), stats: serializeValue(currentCheckInStats(doc.data(), today))})),
    anomalySummary: {scanned: statsSample.size, count: anomalies.length, sample: anomalies.slice(0, 20)},
    backfillRuns: runSnaps.docs.map((doc) => serializeValue(Object.assign({id: doc.id}, doc.data()))),
    definitions: definitions.docs.map((doc) => serializeValue(Object.assign({id: doc.id}, doc.data()))),
  };
});

exports.getEngagementHealth = onCall({region: REGION, cors: true}, async (request) => {
  await requireSuperAdmin(request);
  const cfg = await settings();
  return {ok: true, serviceVersion: "13.29.4", region: REGION,
    projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "unknown",
    serverTime: Date.now(), firestoreRead: true,
    titlesEnabled: cfg.titlesEnabled === true, dailyCheckInEnabled: cfg.dailyCheckInEnabled === true};
});

exports.runTitleBackfill = onCall({region: REGION, cors: true, timeoutSeconds: 120}, async (request) => {
  const actor = await requireSuperAdmin(request);
  const data = request.data || {};
  const execute = data.execute === true;
  const requestedLimit = Number(data.limit || 25);
  if (!Number.isInteger(requestedLimit)) throw new HttpsError("invalid-argument", "invalid-limit");
  const limit = Math.min(100, Math.max(1, requestedLimit));
  const cursor = String(data.cursor || "").trim();
  if (cursor && !validDocumentId(cursor)) throw new HttpsError("invalid-argument", "invalid-cursor");
  let query = db.collection("ladderTransactions").orderBy(FieldPath.documentId()).limit(limit);
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.get();
  if (execute && (await settings()).titlesEnabled !== true) throw new HttpsError("failed-precondition", "feature-disabled");
  const summary = {scanned: snapshot.size, eligible: 0, created: 0, processed: 0, awarded: 0, skipped: 0, failed: 0};
  const errors = [];
  for (const doc of snapshot.docs) {
    try {
      const result = await processOfficialEventLog(doc.data(), doc.id, "historical_backfill", !execute);
      if (result.status === "eligible") summary.eligible += 1;
      else if (result.status === "created") summary.created += 1;
      else if (result.status === "processed") summary.processed += 1;
      else summary.skipped += 1;
      summary.awarded += result.awarded || 0;
      if (result.awardErrors) { summary.failed += 1; errors.push({logId: doc.id, code: "award-evaluation-failed"}); }
    } catch (error) {
      summary.failed += 1;
      errors.push({logId: doc.id, code: String(error && error.code || "unknown")});
    }
  }
  const retryRequired = summary.failed > 0;
  const nextCursor = retryRequired || snapshot.empty ? cursor : snapshot.docs[snapshot.docs.length - 1].id;
  const done = !retryRequired && snapshot.size < limit;
  const runId = randomUUID();
  await db.doc(`titleBackfillRuns/${runId}`).create({
    mode: execute ? "execute" : "preview",
    cursor: cursor || null,
    nextCursor: done ? null : nextCursor,
    done,
    summary,
    errors: errors.slice(0, 20),
    createdBy: actor.uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  return {ok: true, runId, mode: execute ? "execute" : "preview", retryRequired, nextCursor: done ? null : nextCursor, done, summary, errors: errors.slice(0, 20)};
});

exports.updateTitleDefinition = onCall({region: REGION, cors: true}, async (request) => {
  const actor = await requireSuperAdmin(request);
  const data = request.data || {};
  const titleId = String(data.titleId || "").trim();
  if (!validDocumentId(titleId)) throw new HttpsError("invalid-argument", "invalid-title-id");
  const ref = db.doc(`titleDefinitions/${titleId}`);
  const publicRef = db.doc(`publicTitleCatalog/${titleId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "definition-missing");
    const old = snap.data();
    const next = Object.assign({}, old, {
      isActive: data.isActive === true,
      isHidden: data.isHidden === true,
      isArchived: data.isArchived === true,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actor.uid,
    });
    if (next.isArchived) next.isActive = false;
    tx.set(ref, next, {merge: true});
    tx.set(publicRef, publicDefinition(titleId, next), {merge: true});
  });
  await db.collection("titleAuditLogs").doc(safeId(`${actor.uid}_${titleId}_definition_${Date.now()}`)).create({
    action: "update-definition",
    titleId,
    operatorUid: actor.uid,
    changes: {isActive: data.isActive === true, isHidden: data.isHidden === true, isArchived: data.isArchived === true},
    createdAt: FieldValue.serverTimestamp(),
  });
  return {ok: true, titleId};
});

exports.seedInitialTitles = onCall({region: REGION, cors: true}, async (request) => {
  const actor = await requireSuperAdmin(request);
  const definitions = INITIAL_TITLES;
  await db.runTransaction(async (tx) => {
  const refs = definitions.map(item => db.doc(`titleDefinitions/${item.id}`));
  const existing = await Promise.all(refs.map(ref => tx.get(ref)));
  for (const [index, item] of definitions.entries()) {
    const definition = Object.assign({}, item, {
      version: 1,
      isPublic: true,
      isPermanent: true,
      retroactiveEnabled: item.retroactiveEnabled === true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: actor.uid,
    });
    const effective = existing[index].exists ? existing[index].data() : definition;
    if (!existing[index].exists) tx.create(refs[index], definition);
    tx.set(db.doc(`publicTitleCatalog/${item.id}`), publicDefinition(item.id, effective));
  }
  });
  return {ok: true, count: definitions.length};
});

exports.saveEngagementSettings = onCall({region: REGION, cors: true}, async (request) => {
  const actor = await requireSuperAdmin(request);
  const data = request.data || {};
  const payload = {
    titlesEnabled: data.titlesEnabled === true,
    automaticTitleAwardsEnabled: data.automaticTitleAwardsEnabled === true,
    dailyCheckInEnabled: data.dailyCheckInEnabled === true,
    checkInTitleAwardsEnabled: data.checkInTitleAwardsEnabled === true,
    timezone: "Asia/Taipei",
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: actor.uid,
  };
  await db.doc("systemSettings/engagement").set(payload, {merge: true});
  return {ok: true};
});

exports.grantTitle = onCall({region: REGION, cors: true}, async (request) => {
  const actor = await requireSuperAdmin(request);
  const data = request.data || {};
  const uid = String(data.targetUid || "").trim();
  const titleId = String(data.titleId || "").trim();
  const reason = String(data.reason || "").trim();
  if (!validDocumentId(uid) || !validDocumentId(titleId) || reason.length < 2) throw new HttpsError("invalid-argument", "target-title-reason-required");
  const result = await awardTitle({uid, titleId, sourceType: "manual", sourceId: safeId(data.operationId || Date.now()), grantedBy: actor.uid, grantReason: reason});
  return Object.assign({ok: true}, result);
});

exports.revokeTitle = onCall({region: REGION, cors: true}, async (request) => {
  const actor = await requireSuperAdmin(request);
  const data = request.data || {};
  const uid = String(data.targetUid || "").trim();
  const titleId = String(data.titleId || "").trim();
  const reason = String(data.reason || "").trim();
  if (!validDocumentId(uid) || !validDocumentId(titleId) || reason.length < 2) throw new HttpsError("invalid-argument", "target-title-reason-required");
  const earnedRef = db.doc(`users/${uid}/earnedTitles/${titleId}`);
  const userRef = db.doc(`users/${uid}`);
  const definitionRef = db.doc(`titleDefinitions/${titleId}`);
  const auditRef = db.doc(`titleAuditLogs/${safeId(`${uid}_${titleId}_revoke_${data.operationId || Date.now()}`)}`);
  const result = await db.runTransaction(async (tx) => {
    const [earned, user, definition] = await Promise.all([tx.get(earnedRef), tx.get(userRef), tx.get(definitionRef)]);
    if (!earned.exists || earned.data().status === "revoked") return {revoked: false, reason: "not-active"};
    tx.set(earnedRef, {status: "revoked", revokedAt: FieldValue.serverTimestamp(), revokedBy: actor.uid, revokeReason: reason}, {merge: true});
    if (user.exists && user.data().equippedTitleId === titleId) {
      tx.set(userRef, {equippedTitleId: null, titleDisplayEnabled: false, updatedAt: FieldValue.serverTimestamp()}, {merge: true});
      tx.set(db.doc(`publicPlayers/${uid}`), {equippedTitleId: null, titleDisplayEnabled: false, updatedAt: Date.now()}, {merge: true});
    }
    tx.create(auditRef, {action: "revoke", titleId, targetUid: uid, operatorUid: actor.uid, reason, isTestData: earned.data().isTestData === true, createdAt: FieldValue.serverTimestamp()});
    if (definition.exists && earned.data().isTestData !== true) {
      tx.set(definitionRef, {recipientCount: Math.max(0, Number(definition.data().recipientCount || 0) - 1), updatedAt: FieldValue.serverTimestamp()}, {merge: true});
    }
    return {revoked: true};
  });
  return Object.assign({ok: true}, result);
});

const INITIAL_TITLES = [
  {id:"pioneer",code:"PIONEER",name:"開拓者",description:"正式開放後前100名完成玩家資料建檔的正式玩家。",hint:"在 BXH ARENA 正式開放初期完成玩家資料。",category:"launch",rarity:"limited",conditionType:"pioneer_quota",targetValue:1,maxRecipients:100,isLimited:true,isHidden:false,isActive:false,retroactiveEnabled:false},
  {id:"first_generation_warrior",code:"FIRST_GENERATION",name:"初代戰士",description:"第一賽季完成至少一場正式賽事。",hint:"參與第一賽季正式賽事。",category:"launch",rarity:"limited",conditionType:"season_completed_tournaments",targetValue:1,seasonId:"S1",isLimited:true,isHidden:false,isActive:false,retroactiveEnabled:true},
  {id:"first_battle",code:"FIRST_BATTLE",name:"初次上陣",description:"完成第一場正式賽事。",hint:"完成正式積分賽事。",category:"participation",rarity:"common",conditionType:"completed_tournaments",targetValue:1,isActive:true,retroactiveEnabled:true},
  {id:"rookie_hunter",code:"ROOKIE_HUNTER",name:"新銳獵人",description:"累積完成3場正式賽事。",hint:"持續參加正式賽事。",category:"participation",rarity:"common",conditionType:"completed_tournaments",targetValue:3,isActive:true,retroactiveEnabled:true},
  {id:"familiar_face",code:"FAMILIAR_FACE",name:"戰場熟面孔",description:"累積完成10場正式賽事。",hint:"持續參加正式賽事。",category:"participation",rarity:"rare",conditionType:"completed_tournaments",targetValue:10,isActive:true,retroactiveEnabled:true},
  {id:"hundred_battles",code:"HUNDRED_BATTLES",name:"百戰磨練",description:"累積完成30場正式賽事。",hint:"累積更多正式賽事經驗。",category:"participation",rarity:"epic",conditionType:"completed_tournaments",targetValue:30,isActive:true,retroactiveEnabled:true},
  {id:"top16_debut",code:"TOP16_DEBUT",name:"初露鋒芒",description:"首次晉級正式賽事16強。",hint:"在正式賽事突破初期階段。",category:"placement",rarity:"rare",conditionType:"stage_reached",targetValue:16,isActive:false,retroactiveEnabled:false},
  {id:"top8_wall",code:"TOP8_WALL",name:"八強之壁",description:"首次晉級正式賽事8強。",hint:"在正式賽事挺進後段。",category:"placement",rarity:"rare",conditionType:"stage_reached",targetValue:8,isActive:false,retroactiveEnabled:false},
  {id:"semifinal_overlord",code:"TOP4_OVERLORD",name:"四強霸主",description:"首次晉級正式賽事4強。",hint:"在正式賽事挺進四強。",category:"placement",rarity:"epic",conditionType:"best_placement",targetValue:4,isActive:true,retroactiveEnabled:true},
  {id:"champion_hunter",code:"CHAMPION_HUNTER",name:"冠軍獵人",description:"首次獲得正式賽事冠軍。",hint:"贏得正式賽事冠軍。",category:"champion",rarity:"epic",conditionType:"championships",targetValue:1,isActive:true,retroactiveEnabled:true},
  {id:"triple_crown",code:"TRIPLE_CROWN",name:"三冠王",description:"累積獲得3次正式賽事冠軍。",hint:"持續挑戰正式賽事冠軍。",category:"champion",rarity:"legendary",conditionType:"championships",targetValue:3,isActive:true,retroactiveEnabled:true},
  {id:"winning_blade",code:"WINNING_BLADE",name:"連勝之刃",description:"正式對戰連續取得5勝。",hint:"保持正式對戰連勝。",category:"battle",rarity:"epic",conditionType:"win_streak",targetValue:5,isActive:false,retroactiveEnabled:false},
  {id:"undefeated_legend",code:"UNDEFEATED_LEGEND",name:"不敗傳說",description:"單場正式賽事全勝奪冠。",hint:"以不敗戰績完成正式賽事。",category:"battle",rarity:"legendary",conditionType:"undefeated_champion",targetValue:1,isActive:false,retroactiveEnabled:false},
  {id:"four_venues",code:"FOUR_VENUES",name:"四方征戰",description:"在4個不同正式場地完成參賽。",hint:"前往不同正式場地參賽。",category:"exploration",rarity:"epic",conditionType:"unique_venues",targetValue:4,isActive:false,retroactiveEnabled:false},
  {id:"season_king",code:"SEASON_KING",name:"賽季王者",description:"賽季結算時排名第1名。",hint:"登上賽季最終排名第一。",category:"season",rarity:"legendary",conditionType:"season_rank",targetValue:1,isActive:false,retroactiveEnabled:true},
  {id:"first_checkin",code:"FIRST_CHECKIN",name:"初來乍到",description:"首次完成每日簽到。",hint:"在玩家中心完成每日簽到。",category:"checkin",rarity:"common",conditionType:"total_checkins",targetValue:1,isActive:true,retroactiveEnabled:false},
  {id:"seven_day_guest",code:"SEVEN_DAY_GUEST",name:"七日常客",description:"累積完成7天每日簽到。",hint:"累積完成每日簽到。",category:"checkin",rarity:"common",conditionType:"total_checkins",targetValue:7,isActive:true,retroactiveEnabled:false},
  {id:"monthly_hunter",code:"MONTHLY_HUNTER",name:"月度獵人",description:"累積完成30天每日簽到。",hint:"累積完成每日簽到。",category:"checkin",rarity:"rare",conditionType:"total_checkins",targetValue:30,isActive:true,retroactiveEnabled:false},
  {id:"hundred_day_warrior",code:"HUNDRED_DAY_WARRIOR",name:"百日戰士",description:"累積完成100天每日簽到。",hint:"長期持續每日簽到。",category:"checkin",rarity:"epic",conditionType:"total_checkins",targetValue:100,isActive:true,retroactiveEnabled:false}
];
