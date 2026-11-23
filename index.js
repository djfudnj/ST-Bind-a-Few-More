import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    getRequestHeaders,
    chat_metadata,
    getCurrentChatId,
    main_api,
} from '../../../../script.js';
import * as backgroundsModule from '../../../backgrounds.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

const MODULE = 'char_binder';                  // 저장 키: 바꾸면 기존 사용자의 설정이 끊기므로 그대로 둔다
const EXT_NAME = 'Bind a Few More';
const CSS_TAG_ATTR = 'data-cb-css';
const openCssIds = new Set();
// ST 배경 Lock이 채팅 메타데이터에 저장되는 키 (backgrounds.js 의 BG_METADATA_KEY 와 동일)
const BG_METADATA_KEY = 'custom_background';

const defaults = {
    bgColumns: 3,
    bgPreload: false,      // 바인딩된 배경 이미지를 미리 받아 메모리에 잡아 둘지 (기본 꺼짐)
    // { [characterAvatar | "group:<id>"]: { enabled, theme, preset, source, model, background, qrSets[], cssSnippets[{ id, name, css, enabled }] } }
    bindings: {},
};

let backgroundList = [];   // [{ file, thumb }]
let selectedBg = '';
let qrTimer = null;
let lastQrKey = '';            // "chatId|세트목록" — 이미 QR 연결을 확인한 상태

// ------------------------------------------------------------------
// 공용 헬퍼
// ------------------------------------------------------------------

// 화면에 보이는지 (jQuery 의 :visible 과 달리 레이아웃을 강제하지 않는다)
function isShown(el) {
    if (!el) return false;
    return typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0;
}

// Enter / Space 를 누르면 fn 을 부르고 기본 동작은 막는다 (클릭처럼 쓰는 버튼용)
function activateOnKey(e, fn) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    fn();
}

// 팝업 안에 들어갈 내용 틀 (제목 포함). title 은 문자열 또는 노드/jQuery 배열
function createPopupContent(title) {
    const $content = $('<div class="char-binder-settings cb-popup"></div>');
    const $title = $('<h3 class="cb-popup-title"></h3>');
    if (typeof title === 'string') $title.text(title);
    else $title.append(...title);
    return $content.append($title);
}

function createMenuPopup($content, options = {}) {
    return new Popup($content[0], POPUP_TYPE.TEXT, '', { okButton: 'Close', allowVerticalScrolling: true, ...options });
}

// ST 버전에 따라 getBackgroundPath 가 없을 수 있어서 직접 만든다 (ST 와 같은 경로 규칙)
function getBackgroundPath(file) {
    if (typeof backgroundsModule.getBackgroundPath === 'function') return backgroundsModule.getBackgroundPath(file);
    return `backgrounds/${encodeURIComponent(file)}`;
}

function debounce(fn, ms) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

// ------------------------------------------------------------------
// 설정 / 대상 판별
// ------------------------------------------------------------------

// 설정 기본값 보정은 시작할 때 한 번만 한다
function initSettings() {
    extension_settings[MODULE] ??= {};
    const s = extension_settings[MODULE];
    for (const k of Object.keys(defaults)) {
        if (!(k in s)) s[k] = structuredClone(defaults[k]);
    }
}

function getSettings() {
    return extension_settings[MODULE];
}

function getTarget() {
    const ctx = getContext();
    if (ctx.groupId) {
        const group = ctx.groups.find(g => String(g.id) === String(ctx.groupId));
        return { key: `group:${ctx.groupId}`, name: group?.name ?? `Group ${ctx.groupId}`, isGroup: true };
    }
    if (ctx.characterId !== undefined && ctx.characterId !== null) {
        const ch = ctx.characters[ctx.characterId];
        if (ch?.avatar) return { key: ch.avatar, name: ch.name, isGroup: false };
    }
    return null;
}

// 현재(또는 지정한) 캐릭터/그룹의 저장된 바인딩. 없으면 null
function getCurrentBinding(target = getTarget()) {
    return target ? (getSettings().bindings[target.key] ?? null) : null;
}

function isEmptyBinding(b) {
    return !b.theme && !b.preset && !b.source && !b.model && !b.background && !(b.qrSets ?? []).length && !(b.cssSnippets ?? []).length;
}

// 저장된 설정이 하나라도 있는지. qrNames 는 ST 쪽에 연결된 QR 세트 이름 (캐릭터용)
function hasSavedSettings(b, qrNames = []) {
    return (!!b && !isEmptyBinding(b)) || qrNames.length > 0;
}

// ------------------------------------------------------------------
// Quick Reply
// ------------------------------------------------------------------

function getQrApi() {
    return window.quickReplyApi ?? null;
}

function qrAvailable() {
    return !!getQrApi()?.settings;
}

function listAllQrSets() {
    return getQrApi()?.listSets().map(String) ?? [];
}

// QR 확장의 QuickReplyConfig.addSet/removeSet 은 설정 화면의 DOM(setListDom)에 바로 접근한다.
// 설정 화면이 아직 그려지기 전이면 undefined 라서 에러가 나므로 임시 DOM을 달아 둔다.
// (화면이 그려질 때 QR 확장이 진짜 DOM으로 덮어쓴다)
function ensureQrDom(cfg) {
    if (cfg && !cfg.setListDom) cfg.setListDom = document.createElement('div');
    return cfg ?? null;
}

// 현재 캐릭터의 Character Quick Reply Set 설정. 그룹이거나 QR 확장이 아직 준비 전이면 null
function getCharQrConfig(target) {
    const s = getQrApi()?.settings;
    const cfg = s?.charConfig;
    if (!target || target.isGroup || !cfg || s.characterConfigs?.[target.key] !== cfg) return null;
    return ensureQrDom(cfg);
}

// 현재 채팅의 Chat Quick Reply Set 설정. QR 확장이 아직 준비 전이면 null
function getChatQrConfig() {
    return ensureQrDom(getQrApi()?.settings?.chatConfig);
}

function qrSetNames(cfg) {
    return (cfg?.setList ?? []).map(l => l.set?.name).filter(Boolean);
}

// cfg 의 세트 목록을 names 와 같게 맞춘다. 이미 있는 세트는 그대로 둔다 (순서/표시 여부 유지)
function syncQrConfig(cfg, names, { removeMissing = true } = {}) {
    const api = getQrApi();
    const current = qrSetNames(cfg);
    for (const name of names) {
        if (current.includes(name)) continue;
        const set = api.getSetByName(name);
        if (set) cfg.addSet(set, true);
    }
    if (removeMissing) removeQrNames(cfg, current.filter(n => !names.includes(n)));
}

// 그룹: 이 확장이 채팅 세트에 연결해 둔 QR 세트를 해제한다
function releaseGroupQr(names) {
    if (!names.length || !qrAvailable()) return;
    try {
        removeQrNames(getChatQrConfig(), names);
    } catch (err) {
        console.warn(`[${EXT_NAME}] Failed to release group QR sets`, err);
    }
}

function removeQrNames(cfg, names) {
    const api = getQrApi();
    if (!cfg || !api) return;
    const current = qrSetNames(cfg);
    for (const name of names) {
        if (!current.includes(name)) continue;
        const set = api.getSetByName(name);
        if (set) cfg.removeSet(set);
    }
}

// 그룹: 캐릭터 QR 설정이 없으므로 이 그룹의 채팅 세트에 연결한다 (QR 확장 API 직접 호출)
function applyGroupQr(b, force = false) {
    const wanted = b?.qrSets ?? [];
    const cfg = getChatQrConfig();
    if (!wanted.length || !cfg) return;

    const key = `${getCurrentChatId()}|${wanted.join('\u0001')}`;
    if (!force && key === lastQrKey) return;
    lastQrKey = key;

    try {
        syncQrConfig(cfg, wanted, { removeMissing: false });
    } catch (err) {
        console.warn(`[${EXT_NAME}] Failed to link group QR sets`, err);
    }
}

// QR 확장의 CHAT_CHANGED 처리(캐릭터 설정 로드)가 끝난 뒤에 적용하도록 약간 지연
function scheduleQr(target, b, delay, force = false) {
    clearTimeout(qrTimer);
    qrTimer = setTimeout(() => {
        if (target.isGroup) applyGroupQr(b, force);
        refreshQrStatus();
    }, delay);
}

// ------------------------------------------------------------------
// 테마 / 프리셋 / 배경 / CSS 적용
// ------------------------------------------------------------------

// <select> 를 바인딩 값(표시 텍스트 기준)으로 바꾼다. 이미 같은 값이거나 없는 값이면 아무것도 안 하고, 실제로 바꿨을 때만 true
function switchSelect($sel, wantedText) {
    const sel = $sel[0];
    if (!sel || !wantedText) return false;
    if (sel.selectedOptions[0]?.textContent.trim() === wantedText) return false;
    const opt = Array.from(sel.options).find(o => o.textContent.trim() === wantedText);
    if (!opt) return false;
    $sel.val(opt.value).trigger('change');
    return true;
}

function applyTheme(name) {
    // 테마가 실제로 바뀐 경우에만 ST 가 Custom CSS 를 다시 적용하므로, 그때만 추가 CSS 순서를 맞춘다
    if (switchSelect($('#themes'), name)) scheduleCssBump();
}

function applyPreset(name) {
    if (main_api !== 'openai') return; // Chat Completion일 때만 동작
    switchSelect($('#settings_preset_openai'), name);
}

// ---- Chat Completion Source + 모델 ----
// 소스별 모델 입력칸. 여기 없는 소스는 아래 findModelField 의 규칙(#model_<소스>_select 등)으로 찾는다
const MODEL_FIELD_BY_SOURCE = {
    makersuite: '#model_google_select',
    custom: '#custom_model_id',
    azure_openai: '#azure_openai_model',
};

function findModelField(source) {
    const mapped = MODEL_FIELD_BY_SOURCE[source];
    return (mapped && document.querySelector(mapped))
        ?? document.querySelector(`#model_${source}_select`)
        ?? document.querySelector(`#${source}_form select[id^="model_"]`);
}

// 모델명을 입력칸에 넣고 ST 의 change/input 핸들러를 태운다. 실제로 바꿨을 때만 true
function setModelValue(source, model) {
    const el = findModelField(source);
    if (!el) {
        console.warn(`[${EXT_NAME}] Could not find a model field for source "${source}".`);
        return false;
    }
    if (el.value === model) return false;
    if (el.tagName === 'SELECT') {
        // 목록에 없는 모델명도 쓸 수 있게 임시 옵션을 만들어 둔다 (목록을 다시 불러오면 사라지지만 ST 설정값은 유지된다)
        if (!Array.from(el.options).some(o => o.value === model)) {
            const opt = document.createElement('option');
            opt.value = model;
            opt.textContent = model;
            el.append(opt);
        }
        $(el).val(model).trigger('change');
    } else {
        $(el).val(model).trigger('input').trigger('change');
    }
    return true;
}

let modelRunId = 0; // 새 적용이 시작되면 올라간다 (대기 중이던 이전 적용은 스스로 취소)

// 순서: (프리셋은 이미 적용됨) → 소스 전환 → 모델 입력.
// 프리셋/소스가 바뀌면 ST 가 모델 목록을 다시 채우므로 그 뒤에 모델을 넣는다.
// notify: 실제로 소스/모델이 바뀌었을 때만 어디로 바뀌었는지 토스트로 알린다 (대화가 가는 곳이 바뀌므로)
function applyModel(b, delay = 500, notify = true) {
    const runId = ++modelRunId;
    if (main_api !== 'openai' || !b || (!b.source && !b.model)) return; // Chat Completion일 때만 동작
    const name = getTarget()?.name ?? '';
    setTimeout(() => {
        if (runId !== modelRunId) return;
        const $src = $('#chat_completion_source');
        let switched = false;
        if (b.source && $src.val() !== b.source && $src.find('option').toArray().some(o => o.value === b.source)) {
            $src.val(b.source).trigger('change');
            switched = true;
        }

        const finish = (modelChanged) => {
            if (!notify || (!switched && !modelChanged)) return;
            const label = $src.find('option:selected').text().trim() || String($src.val() ?? '');
            const dest = [label, b.model].filter(Boolean).join(' / ');
            toastr.info(`${name ? `${name}: ` : ''}switched to ${dest}`, EXT_NAME);
        };

        if (!b.model) {
            finish(false);
            return;
        }
        const source = $src.val();
        setTimeout(() => {
            if (runId !== modelRunId) return;
            finish(setModelValue(source, b.model));
        }, switched ? 400 : 0);
    }, delay);
}

function isUrlValue(v) {
    return /^(https?:|data:|\/)/i.test(v);
}

// 바인딩 값(파일명 또는 URL) → 불러올 URL (미리보기/Lock/미리받기 공용)
function bgValueToUrl(value) {
    return isUrlValue(value) ? value : getBackgroundPath(value);
}

// ---- ST 배경 Lock 과 직접 연동 (슬래시 커맨드를 쓰지 않는다) ----
// ST 의 Lock 은 chat_metadata.custom_background 에 CSS 값 `url("backgrounds/<인코딩된 파일명>")` 을
// 저장하는 것이 전부다. 우리도 같은 값을 직접 쓰고 읽으므로, 전역 배경 선택을 건드리지 않고
// 배경 패널의 Lock 표시와도 항상 일치한다.

// 바인딩 값(파일명 또는 URL) → ST 가 저장하는 Lock 값
function toLockValue(value) {
    return `url("${bgValueToUrl(value).replace(/"/g, '%22')}")`;
}

// Lock 값 → 바인딩 값(파일명 또는 URL). 채팅 전용 배경처럼 되돌릴 수 없는 값이면 null
function parseLock(lock) {
    const m = /^url\((["']?)(.*)\1\)$/.exec(lock.trim());
    if (!m) return null;
    const inner = m[2];
    if (inner.startsWith('backgrounds/')) {
        try { return decodeURIComponent(inner.slice('backgrounds/'.length)); } catch { return null; }
    }
    if (/^https?:/i.test(inner) || inner.startsWith('/')) return inner.replace(/%22/g, '"');
    return null;
}

function getChatLock() {
    return chat_metadata[BG_METADATA_KEY] ?? '';
}

// ST 의 highlightLockedBackground 와 같은 동작 (배경 패널의 잠금 표시)
function highlightLocked() {
    $('.bg_example.locked-background').removeClass('locked-background');
    const lock = getChatLock();
    if (!lock) return;
    $('.bg_example').filter(function () { return $(this).data('url') === lock; }).addClass('locked-background');
}

function setChatLock(lockValue) {
    chat_metadata[BG_METADATA_KEY] = lockValue;
    saveMetadataDebounced();
    $('#bg1').css('background-image', lockValue);
    highlightLocked();
}

function clearChatLock() {
    delete chat_metadata[BG_METADATA_KEY];
    saveMetadataDebounced();
    $('#bg1').css('background-image', backgroundsModule.background_settings?.url ?? '');
    highlightLocked();
}

// value 배경이 이 채팅의 Lock 일 때만 해제한다 (다른 배경으로 직접 Lock 한 건 그대로 둔다)
function releaseLockFor(value) {
    if (value && getChatLock() === toLockValue(value)) clearChatLock();
}

// 바인딩된 배경을 미리 받아 두고 참조를 잡아 둬서(브라우저가 버리지 않게) 전환할 때 바로 보이게 한다.
// 메모리를 아끼려고 최근에 쓴 것 위주로 BG_PRELOAD_MAX 개만 유지한다.
const BG_PRELOAD_MAX = 10; // 메모리에 잡아 둘 최대 개수
const bgPreloaded = new Map(); // url → Image

function preloadBackground(value) {
    if (!value || !getSettings().bgPreload) return;
    const url = bgValueToUrl(value);
    const existing = bgPreloaded.get(url);
    if (existing) { // 최근 사용 순서로 갱신
        bgPreloaded.delete(url);
        bgPreloaded.set(url, existing);
        return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    img.decode().catch(() => {}); // 없는 파일 등은 무시
    bgPreloaded.set(url, img);
    while (bgPreloaded.size > BG_PRELOAD_MAX) bgPreloaded.delete(bgPreloaded.keys().next().value);
}

let preloadRunId = 0; // 새 미리받기를 시작하거나 기능을 끄면 올라간다 (진행 중이던 작업은 스스로 멈춤)

// 시작 직후 한가할 때 바인딩된 배경들을 하나씩 천천히 미리 받는다 (현재 캐릭터 것을 맨 앞에, 최대 BG_PRELOAD_MAX 개).
function preloadBoundBackgrounds(delay = 1500) { // delay: 첫 다운로드까지 대기(ms)
    const runId = ++preloadRunId;
    const cur = getCurrentBinding();
    const curBg = (cur && cur.enabled !== false) ? cur.background : '';
    const bound = Object.values(getSettings().bindings)
        .filter(b => b.enabled !== false && b.background)
        .map(b => b.background);
    const values = [...new Set([curBg, ...bound].filter(Boolean))].slice(0, BG_PRELOAD_MAX);
    let i = 0;
    const step = () => {
        if (runId !== preloadRunId || i >= values.length || !getSettings().bgPreload) return;
        preloadBackground(values[i++]);
        setTimeout(step, 300); // 하나씩 받는 간격(ms)
    };
    setTimeout(step, delay);
}

// 바인딩 → ST: 채팅을 열 때 바인딩된 배경을 이 채팅의 Lock 으로 건다.
// 이미 같은 Lock 이면 아무것도 안 하고, 다른 배경으로 Lock 돼 있으면 바인딩 쪽으로 맞춘다.
// 단, 이 채팅에 직접 올린 "채팅 전용 배경"을 Lock 해 둔 경우는 바인딩으로 표현할 수 없어서 그대로 둔다.
function applyBackground(value) {
    if (!value || !getCurrentChatId()) return;
    preloadBackground(value);
    const wanted = toLockValue(value);
    const current = getChatLock();
    if (current === wanted) return;
    if (current && parseLock(current) === null) return;
    setChatLock(wanted);
}

// ST → 바인딩: 배경 패널에서 Lock/해제하거나, Lock 중에 다른 배경을 고르면 바인딩도 같이 바꾼다.
// - 이미 배경이 바인딩돼 있는(그리고 켜져 있는) 캐릭터에서만 동작한다. 바인딩 없는 캐릭터의 Lock 은 건드리지 않는다.
// - 해제 버튼을 눌렀을 때만 바인딩의 배경을 비운다 (그 외에 Lock 이 비어 있는 건 무시).
// - 현재 Lock 과 바인딩을 비교만 하므로, 우리가 건 Lock 에 반응해 되돌아가는 일은 없다.
function syncBindingFromLock(action) {
    const s = getSettings();
    const target = getTarget();
    const saved = getCurrentBinding(target);
    if (saved?.background && saved.enabled !== false) {
        const lock = getChatLock();
        let changed = false;
        if (lock) {
            const file = parseLock(lock);
            if (file && file !== saved.background) {
                saved.background = file;
                changed = true;
            }
        } else if (action === 'unlock') {
            saved.background = '';
            if (isEmptyBinding(saved)) delete s.bindings[target.key];
            changed = true;
        }
        if (changed) {
            saveSettingsDebounced();
            refreshBgPanel();
            return;
        }
    }
    updateLockStatus();
}

// 배경 패널의 버튼/썸네일을 눌렀을 때 ST 가 처리를 끝낸 뒤 한 번만 동기화
function hookBackgroundPanel() {
    // 앱 전체가 아니라 배경 패널에만 단다 (capture 라서 ST 쪽 핸들러보다 먼저 불린다)
    const panel = document.getElementById('Backgrounds');
    if (!panel) {
        console.warn(`[${EXT_NAME}] Could not find #Backgrounds, so background lock sync is disabled.`);
        return;
    }
    const syncLater = debounce(syncBindingFromLock, 150);
    panel.addEventListener('click', (e) => {
        if (!e.target.closest('.bg_example')) return;
        const action = e.target.closest('.jg-button')?.getAttribute('data-action') ?? '';
        if (action && action !== 'lock' && action !== 'unlock') return; // 이름 변경/삭제 등은 무관
        syncLater(action);
    }, true);
}

// 배경 칸에서 고르거나 URL을 입력하면 바로 바인딩에 저장하고, 현재 채팅의 Lock 을 걸거나 푼다
function commitBackground(value) {
    const prev = getCurrentBinding()?.background || '';
    if (prev === value) return;
    if (!updateBinding({ background: value })) return;

    if (value) applyBackground(value);
    else releaseLockFor(prev);
    updateLockStatus();
}

// 적용 중인 추가 CSS <style> 들 (목록 순서대로)
const cssEls = new Map(); // id → <style>
let appliedCss = [];

// 추가 CSS 의 <style> 들을 <head> 맨 끝으로 옮겨서(순서 유지), 테마의 Custom CSS 보다 항상 뒤(아래)에 오게 한다
function bumpCssToEnd() {
    if (!appliedCss.length) return;
    // 이미 순서대로 맨 끝이면 옮기지 않는다 (스타일 재계산 방지)
    let node = document.head.lastElementChild;
    let inPlace = true;
    for (let i = appliedCss.length - 1; i >= 0; i--) {
        if (appliedCss[i] !== node) { inPlace = false; break; }
        node = node.previousElementSibling;
    }
    if (!inPlace) appliedCss.forEach(el => document.head.append(el));
}

// 테마를 바꾸면 ST 가 테마의 Custom CSS 를 다시 적용하므로, 그 뒤에 한 번 더 맨 끝으로 옮긴다
const scheduleCssBump = debounce(bumpCssToEnd, 200);

function applyCss(snippets = []) {
    const ordered = [];
    const keep = new Set();
    for (const sn of snippets) {
        const css = sn.css ?? '';
        if (!sn.enabled || !css.trim()) continue;
        let el = cssEls.get(sn.id);
        if (!el) {
            el = document.createElement('style');
            el.setAttribute(CSS_TAG_ATTR, sn.id);
            cssEls.set(sn.id, el);
            document.head.append(el);
        }
        if (el.textContent !== css) el.textContent = css;
        keep.add(sn.id);
        ordered.push(el);
    }
    for (const [id, el] of cssEls) {
        if (keep.has(id)) continue;
        el.remove();
        cssEls.delete(id);
    }

    const inOrder = ordered.every((el, i) =>
        i === 0 || (ordered[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (!inOrder) ordered.forEach(el => document.head.append(el));
    appliedCss = ordered;
}

function newCssId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function applyForCurrent(qrDelay = 700, force = false) {
    const target = getTarget();
    const saved = getCurrentBinding(target);
    const b = (saved && saved.enabled !== false) ? saved : null; // 꺼 둔 바인딩은 적용하지 않음

    // 한 단계가 에러가 나도 나머지는 계속 적용되도록 단계마다 따로 감싼다
    const safe = (label, fn) => {
        try { fn(); } catch (err) { console.warn(`[${EXT_NAME}] Failed to apply ${label}`, err); }
    };
    safe('background', () => applyBackground(b?.background)); // 눈에 바로 보이는 것부터 (테마 전환은 무거울 수 있어서 뒤로)
    safe('theme', () => applyTheme(b?.theme));
    safe('preset', () => applyPreset(b?.preset));
    safe('model', () => applyModel(b)); // 프리셋 뒤에 (프리셋이 소스/모델도 바꾸므로)
    safe('css', () => applyCss(b?.cssSnippets));
    if (b && target) safe('QR', () => scheduleQr(target, b, qrDelay, force));
}

// ------------------------------------------------------------------
// 배경 갤러리
// ------------------------------------------------------------------

function defaultThumb(file) {
    return `thumbnail?type=bg&file=${encodeURIComponent(file)}`;
}

// SillyTavern 자체 Backgrounds 패널에 이미 그려진 목록/썸네일을 그대로 가져온다
function scrapeBackgrounds() {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('#bg_menu_content .bg_example').forEach(el => {
        const file = el.getAttribute('bgfile');
        if (!file || seen.has(file)) return;
        seen.add(file);

        let thumb = el.querySelector('img')?.src ?? '';
        if (!thumb) {
            const inner = el.querySelector('.bg_example_img') ?? el;
            // 인라인 스타일을 먼저 본다 (getComputedStyle 은 스타일 재계산을 강제한다)
            const bg = inner.style.backgroundImage || getComputedStyle(inner).backgroundImage;
            thumb = /url\(["']?(.*?)["']?\)/.exec(bg)?.[1] ?? '';
        }
        out.push({ file, thumb: thumb || defaultThumb(file) });
    });
    return out;
}

async function fetchBackgroundsFromApi() {
    try {
        const res = await fetch('/api/backgrounds/all', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.images ?? []);
        return list
            .map(x => typeof x === 'string' ? x : (x.filename ?? x.name ?? x.file))
            .filter(Boolean)
            .map(file => ({ file, thumb: defaultThumb(file) }));
    } catch (err) {
        console.warn(`[${EXT_NAME}] Failed to fetch backgrounds from the API`, err);
        return [];
    }
}

let backgroundListDomCount = -1; // 목록을 만들 때 ST 배경 패널에 있던 항목 수 (바뀌었는지 가볍게 확인용)

// 배경 목록. force 가 아니고 ST 배경 패널의 항목 수가 그대로면 이미 만든 목록을 재사용한다
async function loadBackgrounds(force = false) {
    const domCount = document.querySelectorAll('#bg_menu_content .bg_example').length;
    if (!force && backgroundList.length && domCount === backgroundListDomCount) return backgroundList;

    let items = scrapeBackgrounds();
    let source = 'ST background panel';
    if (!items.length) {
        items = await fetchBackgroundsFromApi();
        source = 'API';
    }
    backgroundList = items;
    backgroundListDomCount = domCount;
    console.log(`[${EXT_NAME}] ${items.length} backgrounds (${source})`);
    return items;
}

const bgItems = new Map(); // file → { el, lower }  (backgroundList 가 바뀔 때만 다시 만든다)
let bgItemsSource = null;  // bgItems 를 만들 때 쓴 backgroundList
let bgEmptyEl = null;
let markedBgEl = null;

// 썸네일 요소는 목록이 바뀔 때만 만든다 (클릭 핸들러는 buildUI 에서 그리드에 한 번만 위임)
function ensureBgItems(grid) {
    if (bgItemsSource === backgroundList) return;
    bgItemsSource = backgroundList;
    bgItems.clear();
    markedBgEl = null;

    const frag = document.createDocumentFragment();
    for (const { file, thumb } of backgroundList) {
        const item = document.createElement('div');
        item.className = 'cb-bg-item';
        item.dataset.file = file;
        item.title = file;

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = thumb;

        const name = document.createElement('span');
        name.className = 'cb-bg-name';
        name.textContent = file;

        item.append(img, name);
        frag.append(item);
        bgItems.set(file, { el: item, lower: file.toLowerCase() });
    }
    bgEmptyEl = document.createElement('div');
    bgEmptyEl.className = 'cb-bg-empty';
    bgEmptyEl.hidden = true;
    frag.append(bgEmptyEl);
    grid.replaceChildren(frag);
}

// 검색은 요소를 다시 만들지 않고 hidden 만 바꾼다
function renderBgGrid() {
    const grid = document.getElementById('cb_bg_grid');
    grid.style.setProperty('--cb-cols', getSettings().bgColumns);
    ensureBgItems(grid);

    const q = $('#cb_bg_search').val().trim().toLowerCase();
    let shown = 0;
    for (const { el, lower } of bgItems.values()) {
        const hide = !!q && !lower.includes(q);
        el.hidden = hide;
        if (!hide) shown++;
    }
    bgEmptyEl.hidden = shown > 0;
    if (!shown) {
        bgEmptyEl.textContent = backgroundList.length
            ? 'No matching backgrounds.'
            : 'Could not load backgrounds. Try "Reload lists".';
    }
    markSelected();
}

function markSelected() {
    markedBgEl?.classList.remove('selected');
    markedBgEl = bgItems.get(selectedBg)?.el ?? null;
    markedBgEl?.classList.add('selected');
}

function updateBgLabel() {
    const url = $('#cb_bg_url').val().trim();
    const value = url || selectedBg;
    $('#cb_bg_current').text(value || '(No change)');
    const $preview = $('#cb_bg_preview');
    if (value) {
        $preview.css('background-image', `url(${JSON.stringify(bgValueToUrl(value))})`).show();
    } else {
        $preview.hide();
    }
}

function updateLockStatus() {
    const lock = getChatLock();
    const text = !lock ? 'None' : (parseLock(lock) ?? '(chat-specific background)');
    $('#cb_bg_lock_status').text(`Current chat lock: ${text}`);
}

// 저장된 바인딩 기준으로 배경 선택/미리보기/Lock 표시를 다시 맞춘다
function refreshBgUi(b) {
    const bgValue = b?.background ?? '';
    if (bgValue && backgroundList.some(x => x.file === bgValue)) {
        selectedBg = bgValue;
        $('#cb_bg_url').val('');
    } else {
        selectedBg = '';
        $('#cb_bg_url').val(bgValue);
    }
    // 접혀 있거나 닫혀 있어서 안 보이는 갤러리는 그리지 않는다 (펼칠 때 refreshBgPanel 이 그림)
    if (isShown(document.getElementById('cb_bg_grid'))) renderBgGrid();
    updateBgLabel();
    updateLockStatus();
}

function refreshBgPanel() {
    if (!isShown(document.getElementById('cb_bg_grid'))) return updateLockStatus();
    refreshBgUi(getCurrentBinding());
}

// ------------------------------------------------------------------
// QR UI
// ------------------------------------------------------------------

function refreshQrStatus(force = false) {
    const $status = $('#cb_qr_status');
    if (!force && !isShown($status[0])) return; // 패널이 닫혀 있으면 아무것도 안 한다
    const api = getQrApi();
    if (!api?.settings) {
        $status.text('Quick Reply extension not found (it may be disabled).');
        return;
    }
    const target = getTarget();
    const join = (list) => list.join(', ') || 'None';
    const parts = [`Global: ${join(api.listGlobalSets())}`];
    if (target && !target.isGroup) parts.push(`Character: ${join(qrSetNames(getCharQrConfig(target)))}`);
    parts.push(`Current chat: ${join(api.listChatSets())}`);
    $status.text(parts.join('  |  '));
}

// 체크박스 목록이 실제 데이터로 채워졌는지 (아니면 저장 시 QR을 건드리지 않는다)
let qrUiReady = false;
let refreshSeq = 0; // refreshUI 호출 순번 (await 중에 더 새로운 호출/대상 변경이 있었는지 확인용)

function renderQrList(target, groupSelected) {
    const $list = $('#cb_qr_list').empty();
    const $hint = $('#cb_qr_hint');
    qrUiReady = false;

    if (!qrAvailable()) {
        $hint.text('');
        refreshQrStatus(true);
        return;
    }

    let selected;
    if (target.isGroup) {
        $hint.text('Groups have no Character QR sets, so checked sets are linked to the chat automatically whenever you open a chat in this group.');
        selected = groupSelected;
    } else {
        $hint.text('Checked sets are applied immediately to ST\'s Character Quick Reply Set.');
        const cfg = getCharQrConfig(target);
        if (!cfg) {
            $list.append($('<div class="cb-hint">').text('Character QR settings are still loading. Please try "Reload lists" in a moment.'));
            refreshQrStatus(true);
            return;
        }
        selected = qrSetNames(cfg);
    }
    qrUiReady = true;

    const all = listAllQrSets();
    if (!all.length) {
        $list.append($('<div class="cb-hint">').text('No Quick Reply sets found.'));
    }
    const selectedSet = new Set(selected);
    const frag = document.createDocumentFragment();
    for (const name of all) {
        const label = document.createElement('label');
        label.className = 'checkbox_label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = name;
        cb.checked = selectedSet.has(name);
        const text = document.createElement('span');
        text.textContent = name;
        label.append(cb, text);
        frag.append(label);
    }
    $list[0].append(frag);
    refreshQrStatus(true);
}

// ------------------------------------------------------------------
// UI
// ------------------------------------------------------------------

const selectFilledFrom = {}; // selector → 마지막으로 채울 때의 원본 <option> 개수

// 원본 <select> 의 옵션 개수가 그대로면 다시 만들지 않는다
function fillSelectFrom(selector, sourceSelector, emptyLabel, force) {
    const source = document.querySelectorAll(`${sourceSelector} option`);
    if (!force && selectFilledFrom[selector] === source.length) return;
    selectFilledFrom[selector] = source.length;

    const makeOption = (value, text) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        return o;
    };
    const frag = document.createDocumentFragment();
    frag.append(makeOption('', emptyLabel));
    for (const o of source) {
        const text = o.textContent.trim();
        if (text) frag.append(makeOption(text, text));
    }
    document.querySelector(selector).replaceChildren(frag);
}

// Chat Completion Source 목록은 ST 의 #chat_completion_source 에서 그대로 가져온다 (값은 옵션 value, 표시는 텍스트)
function fillSourceSelect(force) {
    const source = document.querySelectorAll('#chat_completion_source option');
    if (!force && selectFilledFrom['#cb_source'] === source.length) return;
    selectFilledFrom['#cb_source'] = source.length;

    const frag = document.createDocumentFragment();
    const makeOption = (value, text) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        return o;
    };
    frag.append(makeOption('', '(No change)'));
    for (const o of source) {
        const text = o.textContent.trim();
        if (o.value && text) frag.append(makeOption(o.value, text));
    }
    document.querySelector('#cb_source').replaceChildren(frag);
}

// only 를 주면 그 항목('theme' | 'preset' | 'model' | 'bg' | 'qr' | 'css')만 다시 그린다
async function refreshUI(force = false, reloadBg = false, only = null) {
    // 설정 패널이 닫혀 있으면 갤러리/QR 목록을 다시 그리지 않는다 (채팅 전환 때마다 돌던 무거운 작업)
    if (!force && !isShown(document.querySelector('.char-binder-settings .inline-drawer-content'))) return;

    const seq = ++refreshSeq;
    const s = getSettings();
    const target = getTarget();
    const want = (section) => !only || only === section;

    $('#cb_target').text(target ? target.name : 'No character selected');
    $('#cb_editor').toggle(!!target);
    $('#cb_target_toggle').toggle(!!target);
    if (!target) return;

    const b = getCurrentBinding(target) ?? {};
    $('#cb_target_enabled').prop('checked', b.enabled !== false);
    $('#cb_target_enabled_title').text(target.isGroup ? 'Apply settings to this group' : 'Apply settings to this character');

    if (want('theme')) {
        fillSelectFrom('#cb_theme', '#themes', '(No change)', reloadBg);
        $('#cb_theme').val(b.theme ?? '');
    }
    if (want('preset')) {
        fillSelectFrom('#cb_preset', '#settings_preset_openai', '(No change)', reloadBg);
        $('#cb_preset').val(b.preset ?? '');
    }
    if (want('model')) {
        fillSourceSelect(reloadBg);
        $('#cb_source').val(b.source ?? '');
        $('#cb_model').val(b.model ?? '');
    }
    if (want('bg')) {
        await loadBackgrounds(reloadBg);
        // 기다리는 사이에 더 새로운 갱신이 시작됐거나 캐릭터/그룹이 바뀌었으면, 옛 데이터로 화면을 그리지 않는다
        // (대상이 바뀐 경우는 CHAT_CHANGED 쪽 갱신이 새로 그려 준다)
        if (seq !== refreshSeq || getTarget()?.key !== target.key) return;
        $('#cb_bg_cols').val(s.bgColumns);
        $('#cb_bg_preload').prop('checked', s.bgPreload);
        refreshBgUi(b);
    }
    if (want('qr')) renderQrList(target, b.qrSets ?? []);
    if (want('css')) renderCssList(b);
}

// ---- 항목별 즉시 반영 (저장 버튼 없음): 값을 바꾸면 이 캐릭터의 바인딩에 저장하고 바로 적용한다 ----

// 이 캐릭터/그룹의 바인딩 일부를 갱신(없으면 새로 만듦). 모든 칸이 비면 바인딩을 지운다
function updateBinding(patch) {
    const s = getSettings();
    const target = getTarget();
    if (!target) return false;
    const b = getCurrentBinding(target)
        ?? { enabled: $('#cb_target_enabled').prop('checked'), theme: '', preset: '', source: '', model: '', background: '', qrSets: [], cssSnippets: [] };
    Object.assign(b, patch);
    if (isEmptyBinding(b)) delete s.bindings[target.key];
    else s.bindings[target.key] = b;
    saveSettingsDebounced();
    return true;
}

function commitTheme(value) {
    if (!updateBinding({ theme: value })) return;
    applyTheme(value);
}

function commitPreset(value) {
    if (!updateBinding({ preset: value })) return;
    applyPreset(value);
}

// 소스/모델명: 바꾸면 이 캐릭터의 바인딩에 저장하고 바로 적용 (바인딩이 꺼져 있으면 저장만)
function commitModel(patch) {
    if (!updateBinding(patch)) return;
    const b = getCurrentBinding();
    applyModel(b?.enabled !== false ? b : null, 0, false); // 직접 바꾼 거라 토스트는 생략
}

// ---- 추가 CSS ----

function renderCssList(b) {
    const list = document.getElementById('cb_css_list');
    const snippets = b?.cssSnippets ?? [];
    if (!snippets.length) {
        const empty = document.createElement('div');
        empty.className = 'cb-css-empty';
        empty.textContent = 'No CSS snippets yet. Use the button below to add one.';
        list.replaceChildren(empty);
        return;
    }
    const tpl = document.getElementById('cb_css_card_tpl').content.firstElementChild;
    const frag = document.createDocumentFragment();
    for (const sn of snippets) {
        const card = tpl.cloneNode(true);
        const open = openCssIds.has(sn.id);
        card.dataset.id = sn.id;
        card.classList.toggle('cb-open', open);
        card.querySelector('.cb-css-title').textContent = sn.name || '(Untitled)';
        card.querySelector('.cb-css-name-input').value = sn.name ?? '';
        card.querySelector('.cb-css-on').checked = !!sn.enabled;
        if (open) fillCssText($(card), sn); // 접힌 카드의 내용은 펼칠 때 채운다
        frag.append(card);
    }
    list.replaceChildren(frag);
}

// 카드의 textarea 는 펼칠 때 한 번만 채운다 (긴 CSS 를 접힌 카드까지 넣지 않으려고)
function fillCssText($card, sn) {
    const ta = $card.find('.cb-css-text')[0];
    if (ta.dataset.filled) return;
    ta.value = sn.css;
    ta.dataset.filled = '1';
}

// 카드 헤더의 제목을 입력칸으로 바꿔 이름을 고칠 수 있게 한다 (끝나면 focusout 핸들러가 저장)
function startCssRename($card) {
    const $input = $card.find('.cb-css-name-input');
    $input.data('orig', $input.val().trim());
    $card.addClass('cb-renaming');
    $input.trigger('focus').trigger('select');
}

function commitSnippet(id, patch, bindingKey) {
    const currentKey = getTarget()?.key;
    const key = bindingKey ?? currentKey;
    const b = key ? getSettings().bindings[key] : null;
    const sn = b?.cssSnippets?.find(x => x.id === id);
    if (!sn) return;
    Object.assign(sn, patch);
    saveSettingsDebounced();
    if (key === currentKey) applyCss(b.cssSnippets); // 다른 캐릭터로 넘어간 뒤라면 저장만 하고 화면엔 적용하지 않는다
}

function addCssSnippet() {
    const target = getTarget();
    if (!target) return;
    const existing = getCurrentBinding(target)?.cssSnippets ?? [];
    const sn = { id: newCssId(), name: `CSS ${existing.length + 1}`, css: '', enabled: true };
    if (!updateBinding({ cssSnippets: [...existing, sn] })) return;
    openCssIds.add(sn.id);
    renderCssList(getCurrentBinding());
    startCssRename($(`#cb_css_list .cb-css-card[data-id="${sn.id}"]`));
}

function deleteCssSnippet(id) {
    const b = getCurrentBinding();
    const sn = b?.cssSnippets?.find(x => x.id === id);
    if (!sn) return;
    if (!window.confirm(`Delete the CSS snippet "${sn.name || '(Untitled)'}"?`)) return;
    const rest = b.cssSnippets.filter(x => x.id !== id);
    openCssIds.delete(id);
    updateBinding({ cssSnippets: rest });
    applyCss(rest);
    renderCssList(getCurrentBinding());
}

// QR 세트: 캐릭터는 ST의 Character Quick Reply Set 에 직접 쓰고(원본이 ST 쪽이라 우리 쪽엔 저장 안 함),
// 그룹은 바인딩에 보관하면서 현재 채팅 세트에 연결/해제한다.
function commitQr() {
    const target = getTarget();
    // 목록이 실제 데이터로 채워진 상태일 때만 체크 결과를 믿는다
    if (!target || !qrUiReady || !qrAvailable()) return;
    const checked = $('#cb_qr_list input:checked').map((_, el) => el.value).get();
    try {
        if (target.isGroup) {
            const prev = getCurrentBinding(target)?.qrSets ?? [];
            updateBinding({ qrSets: checked });
            const cfg = getChatQrConfig();
            if (cfg) {
                removeQrNames(cfg, prev.filter(n => !checked.includes(n)));
                syncQrConfig(cfg, checked, { removeMissing: false });
            }
        } else {
            const cfg = getCharQrConfig(target);
            if (!cfg) {
                toastr.warning('Character QR settings have not loaded yet, so the change could not be applied. Please try again in a moment.', EXT_NAME);
                return;
            }
            syncQrConfig(cfg, checked);
        }
    } catch (err) {
        console.warn(`[${EXT_NAME}] Failed to apply QR sets`, err);
        toastr.error('Something went wrong while applying QR sets. Please check the console.', EXT_NAME);
    }
    refreshQrStatus(true);
}

async function clearBinding() {
    const s = getSettings();
    const target = getTarget();
    if (!target) return;

    const old = getCurrentBinding(target) ?? {};
    delete s.bindings[target.key];
    saveSettingsDebounced();

    // 바인딩이 걸어 둔 배경 Lock 도 같이 해제 (다른 배경으로 직접 Lock 한 건 그대로)
    releaseLockFor(old.background);

    // 그룹은 이 확장이 연결해 둔 채팅 세트만 해제. 캐릭터 QR 세트는 ST 원본 데이터라 건드리지 않는다.
    if (target.isGroup) releaseGroupQr(old.qrSets ?? []);

    applyForCurrent(0, true);
    refreshUI(true);
    toastr.info(`Removed the binding for ${target.name}.`, EXT_NAME);
}

// 지워졌거나 더 이상 없는 캐릭터/그룹에 남아 있는 바인딩 키들
function findOrphanBindings() {
    const ctx = getContext();
    const avatars = new Set(ctx.characters.map(c => c.avatar));
    const groups = ctx.groups ?? [];
    const groupIds = new Set(groups.map(g => String(g.id)));
    return Object.keys(getSettings().bindings).filter(key => {
        if (key.startsWith('group:')) {
            // 그룹 목록이 아직 안 불러와졌을 때 전부 '없는 그룹'으로 오해해서 지우지 않는다
            return groups.length > 0 && !groupIds.has(key.slice('group:'.length));
        }
        return !avatars.has(key);
    });
}

// 없어진 캐릭터/그룹의 바인딩을 확인 후 지운다
async function cleanupOrphanBindings() {
    // 캐릭터 목록이 아직 안 불러와졌을 때 전부 '없는 캐릭터'로 오해해서 지우는 일을 막는다
    if (!getContext().characters.length) {
        toastr.warning('The character list has not loaded yet. Please try again in a moment.', EXT_NAME);
        return;
    }
    const orphans = findOrphanBindings();
    if (!orphans.length) {
        toastr.info('Nothing to clean up.', EXT_NAME);
        return;
    }

    const $content = createPopupContent('Clean Up Leftover Settings');
    $content.append($('<div class="cb-menu-hint"></div>').text(`Remove saved settings for ${orphans.length} deleted character(s) or group(s)?`));
    const $list = $('<div class="cb-orphan-list"></div>').appendTo($content);
    for (const key of orphans) {
        const label = key.startsWith('group:') ? `Group (${key.slice('group:'.length)})` : key.replace(/\.[^.]+$/, '');
        $list.append($('<div></div>').text(label));
    }

    const ok = await new Popup($content[0], POPUP_TYPE.CONFIRM, '', {
        okButton: 'Clean up', cancelButton: 'Cancel', allowVerticalScrolling: true,
    }).show();
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;

    // 팝업이 열려 있는 사이 상태가 바뀌었을 수 있으니 다시 계산하되, 확인창에서 보여 준 것만 지운다
    const s = getSettings();
    const shown = new Set(orphans);
    const stale = findOrphanBindings().filter(key => shown.has(key));
    for (const key of stale) delete s.bindings[key];
    saveSettingsDebounced();
    toastr.success(`Removed ${stale.length} leftover setting(s).`, EXT_NAME);
}

function buildUI() {
    const html = `
    <div class="char-binder-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${EXT_NAME}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="cb-quote">
                    <div class="cb-target">Current target: <b id="cb_target"></b></div>
                    <div id="cb_target_toggle" class="cb-target-toggle">
                        <label class="cb-opt" for="cb_target_enabled">
                            <span class="cb-opt-title" id="cb_target_enabled_title">Apply settings to this character</span>
                            <span class="cb-switch"><input type="checkbox" id="cb_target_enabled"><span class="cb-slider"></span></span>
                        </label>
                        <small class="cb-desc">When off, your saved settings are kept but no longer applied.</small>
                    </div>
                </div>

                <div id="cb_editor">

                    <fieldset data-cb-section="theme" data-cb-icon="fa-solid fa-palette" data-cb-label="UI Theme" class="cb-box cb-collapsible cb-collapsed">
                        <legend class="cb-toggle" tabindex="0" role="button" aria-expanded="false"><i class="fa-solid fa-palette"></i>UI Theme<i class="fa-solid fa-chevron-right cb-chevron"></i></legend>
                        <div class="cb-item">
                            <select id="cb_theme" class="text_pole"></select>
                        </div>
                        <small class="cb-desc cb-fold-hint">UI theme to apply when this character is opened.</small>
                    </fieldset>

                    <fieldset data-cb-section="preset" data-cb-icon="fa-solid fa-sliders" data-cb-label="Chat Completion Preset" class="cb-box cb-collapsible cb-collapsed">
                        <legend class="cb-toggle" tabindex="0" role="button" aria-expanded="false"><i class="fa-solid fa-sliders"></i>Chat Completion Preset<i class="fa-solid fa-chevron-right cb-chevron"></i></legend>
                        <div class="cb-item">
                            <select id="cb_preset" class="text_pole"></select>
                            <small class="cb-hint">Presets only switch when the current API is Chat Completion.</small>
                        </div>
                        <small class="cb-desc cb-fold-hint">Chat Completion preset to apply when this character is opened.</small>
                    </fieldset>

                    <fieldset data-cb-section="model" data-cb-icon="fa-solid fa-microchip" data-cb-label="Chat Completion Source &amp; Model" class="cb-box cb-collapsible cb-collapsed">
                        <legend class="cb-toggle" tabindex="0" role="button" aria-expanded="false"><i class="fa-solid fa-microchip"></i>Chat Completion Source &amp; Model<i class="fa-solid fa-chevron-right cb-chevron"></i></legend>
                        <div class="cb-item">
                            <select id="cb_source" class="text_pole"></select>
                            <input id="cb_model" class="text_pole" type="text" autocomplete="off"
                                   placeholder="Model name (type the provider's model ID exactly)" />
                            <small class="cb-hint">Applied after the preset, only when the current API is Chat Completion. Leave the source on "(No change)" to enter a model for whichever source is active.</small>
                        </div>
                        <small class="cb-desc cb-fold-hint">Source and model to switch to when this character is opened.</small>
                    </fieldset>

                    <fieldset data-cb-section="bg" data-cb-icon="fa-solid fa-image" data-cb-label="Background" id="cb_box_bg" class="cb-box cb-collapsible cb-collapsed">
                        <legend class="cb-toggle" tabindex="0" role="button" aria-expanded="false"><i class="fa-solid fa-image"></i>Background<i class="fa-solid fa-chevron-right cb-chevron"></i></legend>
                        <div class="cb-item">
                            <div id="cb_bg_preview" class="cb-bg-preview"></div>
                            <div class="cb-bg-selected">Selected: <b id="cb_bg_current"></b></div>
                            <div class="cb-row">
                                <input id="cb_bg_search" class="text_pole" type="text" placeholder="Search backgrounds..." />
                                <input id="cb_bg_cols" type="range" min="2" max="5" step="1" title="Thumbnail size (columns)" />
                            </div>
                            <div id="cb_bg_grid" class="cb-bg-grid"></div>
                            <input id="cb_bg_url" class="text_pole" type="text"
                                   placeholder="Or enter an image URL directly (takes priority if filled)" />
                            <small id="cb_bg_lock_status" class="cb-hint"></small>
                        </div>
                        <div class="cb-item">
                            <label class="cb-opt" for="cb_bg_preload">
                                <span class="cb-opt-title">Preload backgrounds</span>
                                <span class="cb-switch"><input type="checkbox" id="cb_bg_preload"><span class="cb-slider"></span></span>
                            </label>
                            <small class="cb-desc">Keeps bound background images loaded in memory (up to the 10 most recent) so backgrounds switch faster when you change characters. Note: this uses extra memory.</small>
                        </div>
                        <small class="cb-desc cb-fold-hint">Choose a background image and preview it.</small>
                    </fieldset>

                    <fieldset data-cb-section="qr" data-cb-icon="fa-solid fa-bolt" data-cb-label="Quick Reply Sets" id="cb_box_qr" class="cb-box cb-collapsible cb-collapsed">
                        <legend class="cb-toggle" tabindex="0" role="button" aria-expanded="false"><i class="fa-solid fa-bolt"></i>Quick Reply Sets<i class="fa-solid fa-chevron-right cb-chevron"></i></legend>
                        <div class="cb-item">
                            <small id="cb_qr_status" class="cb-hint"></small>
                            <div id="cb_qr_list" class="cb-qr-list"></div>
                            <small id="cb_qr_hint" class="cb-hint"></small>
                        </div>
                        <small class="cb-desc cb-fold-hint">Quick Reply sets to link to this character.</small>
                    </fieldset>

                    <fieldset data-cb-section="css" data-cb-icon="fa-solid fa-code" data-cb-label="Additional Custom CSS" class="cb-box cb-collapsible cb-collapsed">
                        <legend class="cb-toggle" tabindex="0" role="button" aria-expanded="false"><i class="fa-solid fa-code"></i>Additional Custom CSS<i class="fa-solid fa-chevron-right cb-chevron"></i></legend>
                        <div class="cb-item">
                            <template id="cb_css_card_tpl">
                                <div class="cb-css-card">
                                    <div class="cb-css-head">
                                        <div class="cb-css-name" role="button" tabindex="0">
                                            <i class="fa-solid fa-chevron-right cb-css-chevron"></i>
                                            <span class="cb-css-title"></span>
                                        </div>
                                        <input type="text" class="text_pole cb-css-name-input" placeholder="Name" />
                                        <i class="fa-solid fa-pencil cb-css-edit" role="button" tabindex="0" title="Rename"></i>
                                        <i class="fa-solid fa-trash-can cb-css-del" role="button" tabindex="0" title="Delete"></i>
                                        <span class="cb-switch"><input type="checkbox" class="cb-css-on"><span class="cb-slider"></span></span>
                                    </div>
                                    <div class="cb-css-body">
                                        <textarea class="text_pole textarea_compact cb-css-text" rows="6"
                                                  placeholder="e.g. #chat { font-family: serif; }"></textarea>
                                    </div>
                                </div>
                            </template>
                            <div id="cb_css_list" class="cb-css-list"></div>
                            <div id="cb_css_add" class="menu_button menu_button_icon cb-css-add">
                                <i class="fa-solid fa-plus"></i><span>Add CSS</span>
                            </div>
                            <small class="cb-desc">Applied after the theme's Custom CSS. If selectors match, this takes priority.</small>
                        </div>
                        <small class="cb-desc cb-fold-hint">CSS snippets that apply only to this character (applied after the theme CSS).</small>
                    </fieldset>

                    <div class="cb-buttons">
                        <div id="cb_clear" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-trash-can"></i><span>Delete binding</span>
                        </div>
                        <div id="cb_reload" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-rotate"></i><span>Reload lists</span>
                        </div>
                    </div>
                </div>

                <div class="cb-buttons">
                    <div id="cb_cleanup" class="menu_button menu_button_icon" title="Remove settings left behind by deleted characters or groups">
                        <i class="fa-solid fa-broom"></i><span>Clean up leftover settings</span>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    // 이 캐릭터/그룹의 바인딩 켜기/끄기 (저장된 설정은 그대로 두고 적용만 켜고 끈다)
    $('#cb_target_enabled').on('change', function () {
        const b = getCurrentBinding();
        if (!b) return; // 아직 바인딩이 없으면, 첫 항목을 설정할 때 이 토글 상태로 같이 기록된다
        b.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        applyForCurrent(0, true);
    });

    $('#cb_bg_preload').on('change', function () {
        const s = getSettings();
        s.bgPreload = $(this).prop('checked');
        saveSettingsDebounced();
        if (s.bgPreload) {
            preloadBackground(getCurrentBinding()?.background);
            preloadBoundBackgrounds(0);
        } else {
            preloadRunId++;      // 진행 중인 미리받기 중단
            bgPreloaded.clear(); // 잡아 둔 이미지를 놓아 준다
        }
    });
    // 썸네일 클릭: 그리드에 한 번만 위임
    $('#cb_bg_grid').on('click', '.cb-bg-item', function () {
        const file = this.dataset.file;
        selectedBg = (selectedBg === file) ? '' : file;
        $('#cb_bg_url').val('');
        markSelected();
        updateBgLabel();
        commitBackground(selectedBg);
    });
    $('#cb_bg_search').on('input', debounce(renderBgGrid, 150));
    $('#cb_bg_cols').on('input', function () {
        const cols = Number($(this).val());
        getSettings().bgColumns = cols;
        saveSettingsDebounced();
        document.getElementById('cb_bg_grid').style.setProperty('--cb-cols', cols);
    });
    // URL 입력 중에는 미리보기를 잠깐 기다렸다가 갱신 (한 글자마다 이미지 요청이 나가지 않게)
    const updateBgLabelDebounced = debounce(updateBgLabel, 400);
    $('#cb_bg_url').on('input', () => {
        if ($('#cb_bg_url').val().trim() && selectedBg) {
            selectedBg = '';
            markSelected();
        }
        updateBgLabelDebounced();
    });
    // URL 은 입력을 마치면(Enter / 포커스 이동) 바로 반영
    $('#cb_bg_url').on('change', () => {
        updateBgLabel();
        commitBackground($('#cb_bg_url').val().trim() || selectedBg);
    });
    $('#cb_theme').on('change', function () { commitTheme($(this).val()); });
    $('#cb_preset').on('change', function () { commitPreset($(this).val()); });
    $('#cb_source').on('change', function () { commitModel({ source: $(this).val() }); });
    $('#cb_model').on('change', function () { commitModel({ model: $(this).val().trim() }); });
    $('#cb_qr_list').on('change', 'input[type="checkbox"]', commitQr);
    $('#cb_css_add').on('click', addCssSnippet);
    const cssTimers = {};
    const debounceCss = (id, key, patch) => {
        const timerKey = id + key;
        const bindingKey = getTarget()?.key; // 대기 중에 캐릭터가 바뀌어도 입력한 대상에 저장
        clearTimeout(cssTimers[timerKey]);
        cssTimers[timerKey] = setTimeout(() => {
            delete cssTimers[timerKey];
            commitSnippet(id, patch, bindingKey);
        }, 400); // 타이핑이 멈추면 반영
    };
    const cardId = (el) => $(el).closest('.cb-css-card').attr('data-id');
    $('#cb_css_list')
        .on('click', '.cb-css-name', function () {
            const id = cardId(this);
            const $card = $(this).closest('.cb-css-card');
            if ($card.toggleClass('cb-open').hasClass('cb-open')) {
                openCssIds.add(id);
                const sn = getCurrentBinding()?.cssSnippets?.find(x => x.id === id);
                if (sn) fillCssText($card, sn);
            } else {
                openCssIds.delete(id);
            }
        })
        .on('keydown', '.cb-css-name, .cb-css-del, .cb-css-edit', function (e) {
            activateOnKey(e, () => $(this).trigger('click'));
        })
        .on('click', '.cb-css-del', function () { deleteCssSnippet(cardId(this)); })
        .on('change', '.cb-css-on', function () { commitSnippet(cardId(this), { enabled: $(this).prop('checked') }); })
        .on('click', '.cb-css-edit', function () { startCssRename($(this).closest('.cb-css-card')); })
        .on('keydown', '.cb-css-name-input', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); this.blur(); }
            else if (e.key === 'Escape') { e.preventDefault(); $(this).val($(this).data('orig')); this.blur(); }
        })
        .on('focusout', '.cb-css-name-input', function () {
            const $input = $(this);
            const $card = $input.closest('.cb-css-card');
            if (!$card.hasClass('cb-renaming')) return; // 이미 마무리된 뒤에 또 오는 focusout 은 무시
            const name = $input.val().trim();
            const changed = name !== $input.data('orig');
            $input.data('orig', name).val(name);
            $card.removeClass('cb-renaming');
            $card.find('.cb-css-title').text(name || '(Untitled)');
            if (changed) commitSnippet(cardId(this), { name });
        })
        .on('input', '.cb-css-text', function () {
            debounceCss(cardId(this), 'css', { css: $(this).val() });
        });
    $('#cb_clear').on('click', clearBinding);
    $('#cb_cleanup').on('click', cleanupOrphanBindings);
    $('#cb_reload').on('click', () => refreshUI(true, true)); // 목록 새로고침은 배경 목록도 다시 읽는다
    $('.char-binder-settings .inline-drawer-toggle').on('click', function () {
        // ST 가 아이콘을 바꾸기 전에 불리므로, 이미 'up' 이면 지금 닫히는 중 → 갱신할 필요 없음
        if ($(this).find('.inline-drawer-icon').hasClass('up')) return;
        refreshUI(true);
    });

    for (const box of document.querySelectorAll('.char-binder-settings .cb-collapsible')) {
        const head = box.querySelector('.cb-toggle');
        const toggle = () => {
            const collapsed = box.classList.toggle('cb-collapsed');
            head.setAttribute('aria-expanded', String(!collapsed));
            // 접혀 있는 동안은 상태 줄을 갱신하지 않으므로 펼칠 때 한 번 맞춰 준다
            if (!collapsed && box.id === 'cb_box_qr') refreshQrStatus(true);
            if (!collapsed && box.id === 'cb_box_bg') refreshBgPanel();
        };
        head.addEventListener('click', toggle);
        head.addEventListener('keydown', (e) => activateOnKey(e, toggle));
        box.querySelector('.cb-fold-hint')?.addEventListener('click', toggle);
    }
}

// ------------------------------------------------------------------
// 캐릭터 편집 화면 바로가기 (별 버튼 옆 아이콘 → ST 팝업 → 항목별 설정)
// ------------------------------------------------------------------

let quickMenuBusy = false;

function sectionInfo(box) {
    const { cbSection: section, cbIcon: icon, cbLabel: label } = box.dataset;
    return { section, icon, label };
}

function makeMenuItem(icon, label, onClick, { dim = false, note = '' } = {}) {
    const $item = $('<div class="cb-menu-item" role="button" tabindex="0"></div>')
        .append($('<i></i>').addClass(icon), $('<span class="cb-menu-label"></span>').text(label));
    if (note) $item.append($('<small class="cb-menu-note"></small>').text(note));
    if (dim) $item.addClass('cb-dim');
    return $item
        .on('click', onClick)
        .on('keydown', function (e) {
            activateOnKey(e, () => $(this).trigger('click'));
        });
}

// 이글루 버튼: 캐릭터면 항목 메뉴, 그룹이면 멤버 목록(설정 불러오기) + 그룹 설정 버튼
async function openQuickMenu() {
    const target = getTarget();
    if (!target || quickMenuBusy) return;
    quickMenuBusy = true;
    try {
        if (target.isGroup) {
            const pick = await openGroupMenu(target);
            if (!pick) return;
            if (pick.kind === 'member') {
                await importMemberBinding(pick.avatar, pick.name);
                return;
            }
        }
        await openSectionMenu(target);
    } finally {
        quickMenuBusy = false;
    }
}

// 항목 고르는 팝업. 하나를 고르면 팝업을 닫고 그 항목의 설정 팝업을 연다
async function openSectionMenu(target) {
    const $content = createPopupContent(target.name);
    const $list = $('<div class="cb-menu-list"></div>').appendTo($content);

    const popup = createMenuPopup($content);
    let chosen = null;

    document.querySelectorAll('#cb_editor > .cb-box[data-cb-section]').forEach((box) => {
        const { section, icon, label } = sectionInfo(box);
        makeMenuItem(icon, label, () => { chosen = section; popup.complete(POPUP_RESULT.AFFIRMATIVE); }).appendTo($list);
    });

    await popup.show();
    if (chosen) await openSectionPopup(chosen);
}

// ---- 그룹: 멤버 캐릭터의 설정을 이 그룹으로 불러오기 ----

// 그룹 멤버 [{ avatar, name }]
function getGroupMembers() {
    const ctx = getContext();
    const group = ctx.groups?.find(g => String(g.id) === String(ctx.groupId));
    return (group?.members ?? []).map((avatar) => {
        const ch = ctx.characters?.find(c => c.avatar === avatar);
        return { avatar, name: ch?.name ?? String(avatar).replace(/\.[^.]+$/, '') };
    });
}

// 캐릭터가 ST 의 Character Quick Reply Set 에 연결해 둔 세트 이름들 (읽기만 한다)
function getCharacterQrNames(avatar) {
    const names = new Set(getSettings().bindings[avatar]?.qrSets ?? []);
    const cfg = getQrApi()?.settings?.characterConfigs?.[avatar];
    for (const l of cfg?.setList ?? []) {
        const n = l.set?.name;
        if (n) names.add(n);
    }
    return [...names];
}

// 그룹 메뉴: 멤버 이름 버튼들 + 그 아래 "이 그룹 설정" 버튼. 고른 것을 돌려준다
async function openGroupMenu(target) {
    const members = getGroupMembers();
    const $content = createPopupContent(target.name);
    $content.append($('<div class="cb-menu-hint"></div>').text('Select a member to import that character\'s settings into this group.'));
    const $list = $('<div class="cb-menu-list"></div>').appendTo($content);

    const popup = createMenuPopup($content);
    let picked = null;
    const pick = (value) => { picked = value; popup.complete(POPUP_RESULT.AFFIRMATIVE); };

    if (!members.length) $list.append($('<div class="cb-menu-hint"></div>').text('No members.'));
    for (const m of members) {
        const has = hasSavedSettings(getSettings().bindings[m.avatar], getCharacterQrNames(m.avatar));
        makeMenuItem('fa-solid fa-user', m.name, () => pick({ kind: 'member', ...m }),
            { dim: !has, note: has ? '' : 'No settings' }).appendTo($list);
    }

    $content.append($('<div class="cb-menu-sep"></div>'));
    const $own = $('<div class="cb-menu-list"></div>').appendTo($content);
    makeMenuItem('fa-solid fa-gear', 'This group\'s settings', () => pick({ kind: 'group' })).appendTo($own);

    await popup.show();
    return picked;
}

// 멤버 캐릭터의 설정(테마/프리셋/배경/QR/CSS)을 이 그룹의 바인딩으로 복사한다 (확인 후, 기존 그룹 설정은 덮어씀)
async function importMemberBinding(avatar, name) {
    const target = getTarget();
    if (!target?.isGroup) return;
    const s = getSettings();
    const src = s.bindings[avatar];
    const qrNames = getCharacterQrNames(avatar);
    const snippets = (src?.cssSnippets ?? []).map(sn => ({ ...sn, id: newCssId() }));
    if (!hasSavedSettings(src, qrNames)) {
        toastr.info(`${name} has no saved settings.`, EXT_NAME);
        return;
    }

    const ok = await new Popup(
        `Import ${name}'s settings (theme, preset, source/model, background, QR, CSS) into this group?\nThis will overwrite the group's existing settings.`,
        POPUP_TYPE.CONFIRM, '', { okButton: 'Import', cancelButton: 'Cancel' },
    ).show();
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;

    const prev = getCurrentBinding(target);
    s.bindings[target.key] = {
        enabled: true,
        theme: src?.theme ?? '',
        preset: src?.preset ?? '',
        source: src?.source ?? '',
        model: src?.model ?? '',
        background: src?.background ?? '',
        qrSets: qrNames,
        cssSnippets: snippets,
    };
    saveSettingsDebounced();
    
    if (!src?.background) releaseLockFor(prev?.background);
    releaseGroupQr((prev?.qrSets ?? []).filter(n => !qrNames.includes(n)));

    applyForCurrent(0, true);
    await refreshUI(true);
    toastr.success(`Imported ${name}'s settings into this group.`, EXT_NAME);
}

// 설정 패널의 해당 박스를 그대로 팝업에 띄운다 (같은 요소라서 설정 패널과 항상 같은 상태)
async function openSectionPopup(section) {
    const target = getTarget();
    if (!target) return;
    await refreshUI(true, false, section);

    const box = document.querySelector(`#cb_editor > .cb-box[data-cb-section="${section}"]`);
    if (!box) return;
    const { icon, label } = sectionInfo(box);

    const ph = document.createComment('cb-placeholder');
    box.before(ph);
    const wasCollapsed = box.classList.contains('cb-collapsed');
    box.classList.remove('cb-collapsed');
    box.classList.add('cb-in-modal');

    const $content = createPopupContent([
        $('<i></i>').addClass(icon),
        $('<span></span>').text(label),
        $('<small></small>').text(target.name),
    ]);
    $content.append(box);

    try {
        const popup = createMenuPopup($content, { wide: section === 'bg' });
        // 팝업이 화면에 뜬 뒤에야 보이는 항목(배경 갤러리, QR 상태)을 맞춘다
        setTimeout(() => {
            if (section === 'bg') refreshBgPanel();
            if (section === 'qr') refreshQrStatus(true);
        }, 150);
        await popup.show();
    } finally {
        ph.replaceWith(box);
        box.classList.remove('cb-in-modal');
        box.classList.toggle('cb-collapsed', wasCollapsed);
        box.querySelector('.cb-toggle')?.setAttribute('aria-expanded', String(!wasCollapsed));
    }
}

// 캐릭터 / 그룹 편집 화면에 아이콘
function installQuickButton() {
    const spots = [
        ['#favorite_button', 'cb_quick_button'],            // 캐릭터
        ['#group_favorite_button', 'cb_quick_button_group'], // 그룹
    ];
    for (const [starSel, id] of spots) {
        if (document.getElementById(id)) continue;
        const $star = $(starSel);
        if (!$star.length) {
            console.warn(`[${EXT_NAME}] Could not find ${starSel}, so the shortcut icon was not added.`);
            continue;
        }
        const $btn = $(`<div id="${id}" class="menu_button fa-solid fa-igloo interactable" tabindex="0" title="${EXT_NAME}"></div>`);
        $btn.on('click', openQuickMenu);
        $btn.on('keydown', function (e) {
            activateOnKey(e, () => $(this).trigger('click'));
        });
        $star.after($btn);
    }
}

// ------------------------------------------------------------------
// 초기화
// ------------------------------------------------------------------

jQuery(async () => {
    initSettings();
    buildUI();
    installQuickButton();
    hookBackgroundPanel();

    const refreshUiLater = debounce(() => refreshUI(), 800);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        applyForCurrent();
        refreshUiLater();
    });

    applyForCurrent();
    refreshUI();
    preloadBoundBackgrounds();
    console.log(`[${EXT_NAME}] loaded`);
});
