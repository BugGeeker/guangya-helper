// ==UserScript==
// @name         光鸭快捷操作
// @namespace    serenalee.guangyapan.cross-selection
// @version      0.1.0
// @description  跨目录记录光鸭页面中勾选的文件/文件夹，并在浮窗中按目录分组展示，支持批量移动、删除、解压等操作。
// @author       Serena Lee
// @license      Copyright (c) 2026 Serena Lee. All rights reserved.
// @match        https://guangyapan.com/*
// @match        https://*.guangyapan.com/*
// @icon         https://image.868717.xyz/file/1776301692011_3.svg
// @run-at       document-idle
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.guangyapan.com
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '0.1.0';
  const LOG_PREFIX = '[光鸭快捷操作]';

  // 与批量助手脚本完全隔离的命名空间，避免双方同时安装时互相干扰。
  const CAPTURE_EVENT = '__GYP_CROSS_SEL_CAPTURE__';
  const HOOK_FLAG = '__gypCrossSelHookInstalled';
  const STORAGE_KEY = '__GYP_CROSS_SEL_RECORDS_V1__';
  const POSITION_KEY = '__GYP_CROSS_SEL_POSITION__';
  const ROOT_ID = 'gyp-cross-sel-root';

  // 与guangya_quickly脚本共享的 Token 存储键，任一脚本嗅探到凭证都可复用。
  const GYP_AUTH_STORAGE_KEY = '__GUANGYA_CLOUD_QUICKLY_AUTH__';

  // 光鸭云盘 API（/userres/v1 为新路径，与磁力云添加脚本一致）。
  const API_BASE = 'https://api.guangyapan.com';
  const FILE_LIST_URL = API_BASE + '/userres/v1/file/get_file_list';
  const MOVE_FILE_URL = API_BASE + '/userres/v1/file/move_file';
  const TASK_STATUS_URL = API_BASE + '/userres/v1/get_task_status';
  const DECOMPRESS_URL = API_BASE + '/userres/v1/decompress_files';
  const DECOMPRESS_STATUS_URL = API_BASE + '/userres/v1/query_decompress_status';
  const DELETE_FILE_URL = API_BASE + '/userres/v1/file/delete_file';
  const MANUAL_TOKEN_KEY = 'gyp_token';

  const CONFIG = {
    debug: false,
    pollIntervalMs: 1500,      // 可见行同步轮询间隔
    saveDebounceMs: 400,       // 持久化防抖
    persistAcrossReloads: true,// 跨刷新持久化（关掉则仅本次会话内跨目录）
    scanScrollDelayMs: 220,    // “扫描勾选”自动滚动时每屏停留
    scanMaxRounds: 200,
    move: {
      batchSize: 1000,           // 单次 move_file 最多提交的文件数
      taskPollMs: 1500,        // 任务状态轮询间隔
      taskPollMaxTries: 180,   // 任务状态轮询最大次数
    },
  };

  // =========================
  // 状态
  // =========================
  const STATE = {
    // 当前目录上下文：来自 get_file_list 请求体的 parentId，没有时回退到 url。
    currentDir: { parentId: '', name: '', url: '' },
    // 各目录已捕获的文件列表：{ [parentId]: { items, name, url, updatedAt } }
    capturedByDir: {},
    // 跨目录收集结果：identity -> item
    collected: new Map(),
    // 最近一次渲染签名，用于避免无变化时的重绘
    lastSignature: '',
    pollTimer: null,
    scanning: false,
    // 解压任务进度：{ [taskId]: { decompressing: true, taskId, completed: Set<identity>, progress: number, text: string } }
    decompressTasks: new Map(),
    // 拖拽状态
    dragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
    dragStartX: 0,
    dragStartY: 0,
    ignoreNextClick: false,
    // 监听状态：true=暂停，false=运行中
    paused: true,
  };

  const UI = {
    root: null,
    panel: null,
    headerCount: null,
    listEl: null,
    footer: null,
    collapsed: true,
  };

  // =========================
  // 通用工具
  // =========================
  function log(...args) {
    if (CONFIG.debug) {
      console.log(LOG_PREFIX, ...args);
    }
  }

  function safeJsonParse(text) {
    if (typeof text !== 'string' || !text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced(...args) {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, wait);
    };
  }

  function normalizeDomName(name) {
    return String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getExt(name) {
    const text = String(name || '');
    const match = text.match(/\.([a-z0-9]{1,12})$/iu);
    return match ? match[1].toLowerCase() : '';
  }

  function formatSizeFromBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) {
      return '';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = n;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    const digits = value < 10 && i > 0 ? 1 : 0;
    return `${value.toFixed(digits)} ${units[i]}`;
  }

  // 从行文本里抽取形如 “1.2 GB” 的大小，作为没有 API 数据时的回退。
  function extractSizeTextFromRow(row) {
    if (!row) {
      return '';
    }
    const text = normalizeDomName(row.innerText || row.textContent || '');
    if (!text) {
      return '';
    }
    const match = text.match(/\b\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB|PB)\b/i);
    return match ? normalizeDomName(match[0]) : '';
  }

  function isVisibleElement(node) {
    return Boolean(node && typeof node.getClientRects === 'function' && node.getClientRects().length > 0);
  }

  function isHelperPanelNode(node) {
    return Boolean(node && typeof node.closest === 'function' && node.closest(`#${ROOT_ID}`));
  }

  // =========================
  // Token / API 工具（批量移动功能）
  // =========================


  function normalizeAuth(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return '';
    return /^Bearer\s+/i.test(text) ? text : ('Bearer ' + text);
  }

  function getCloudToken() {
    // 1. 手动设置的 Token
    try {
      const manual = GM_getValue(MANUAL_TOKEN_KEY, '');
      if (manual && manual.trim()) return normalizeAuth(manual);
    } catch (e) {}
    // 2. 自动嗅探/存储
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(GYP_AUTH_STORAGE_KEY, '');
        if (typeof v === 'string' && v.trim()) return normalizeAuth(v);
      }
    } catch (e) {}
    try {
      return normalizeAuth(window.localStorage.getItem(GYP_AUTH_STORAGE_KEY) || '');
    } catch (e) {
      return '';
    }
  }

  function gmApiRequest(method, url, bodyObj) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method,
        url: url,
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': getCloudToken()
        },
        data: bodyObj ? JSON.stringify(bodyObj) : undefined,
        onload: function (r) {
          let json = null;
          try { json = JSON.parse(r.responseText); } catch (e) {}
          resolve({ status: r.status, json: json, text: r.responseText });
        },
        onerror: function () { reject(new Error('网络请求失败，请检查网络')); },
        ontimeout: function () { reject(new Error('请求超时')); }
      });
    });
  }

  function parseApiResult(r) {
    let ok = r.status >= 200 && r.status < 300;
    let msg = '';
    if (r.json) {
      if (r.json.msg != null && r.json.msg !== 'success') { ok = false; msg = r.json.msg; }
      if (r.json.code != null && r.json.code !== 0) { ok = false; msg = msg || ('code=' + r.json.code); }
    }
    if (!ok && !msg) msg = r.text ? r.text.slice(0, 200) : ('HTTP ' + r.status);
    if (r.status === 401) msg = (msg ? msg + '；' : '') + 'Token 可能已过期，请更新';
    return { ok: ok, msg: msg, json: r.json };
  }

  // =========================
  // 名称 / 文本候选（与批量助手同思路：取行内最长的“有用”文本作为文件名）
  // =========================
  function isProbablyUsefulName(name) {
    const text = normalizeDomName(name);
    if (!text) {
      return false;
    }
    const compact = text.replace(/\s+/gu, '');
    if (compact.length < 2 && !/^[A-Za-z0-9一-龥]$/u.test(compact)) {
      return false;
    }
    const blacklist = ['上传', '新建文件夹', '云添加', '文件', '文件名称', '大小', '类型', '文件夹', '其他', '未知类型', '-'];
    if (blacklist.includes(text)) {
      return false;
    }
    return true;
  }

  function isProbablyMetadataText(text) {
    const value = normalizeDomName(text);
    if (!value) {
      return true;
    }
    const compact = value.replace(/\s+/gu, '').toLowerCase();
    // 排序图标 aria-label：sorttriangle / sorttriangledesc / sorttriangleasc ...
    if (/^(?:sort(?:triangle)?(?:asc|desc|ascending|descending)?|sorttriangle(?:asc|desc)?|triangle(?:asc|desc)?|caret(?:up|down)?|arrow(?:up|down)?|sorter|sortascend|sortdescend)$/u.test(compact)) {
      return true;
    }
    // 常见图标 aria-label（typefolder/typevideo/moreactions/close/upload ...）
    if (/^(?:type(?:folder|file|video|audio|image|document|other|torrent|unknown)|moreactions?|close|search|menu|upload|download|rename|delete|move|share|copy|preview|play|edit|add|setting|settings|filter|refresh|back|forward|expand|collapse|selectall|checkbox)$/iu.test(compact)) {
      return true;
    }
    return (
      /^(type(?:unknown|file|folder|video|audio|image|document|other|torrent)|filetypeunknown)$/i.test(value) ||
      /^(其他|未知类型|文件类型|视频|图片|音频|文档|压缩包|种子|字幕)$/u.test(value) ||
      /^\d+(\.\d+)?\s*(B|KB|MB|GB|TB|PB)$/i.test(value) ||
      /^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(value) ||
      /^(今天|昨天|刚刚|\d{1,2}:\d{2})$/.test(value) ||
      /^\d+$/.test(value) ||
      /(?:已选(?:择)?|已勾选)\s*\d+\s*(?:项|个)/u.test(value)
    );
  }

  function collectTextCandidates(row) {
    const out = new Set();
    const push = (value) => {
      const text = normalizeDomName(value);
      if (!isProbablyUsefulName(text) || isProbablyMetadataText(text)) {
        return;
      }
      out.add(text);
    };

    if (!row) {
      return [];
    }

    push(row.getAttribute && row.getAttribute('title'));
    push(row.getAttribute && row.getAttribute('aria-label'));

    const attrNodes = Array.from(row.querySelectorAll('[title], [aria-label], [data-name], [data-filename]'));
    for (const node of attrNodes) {
      push(node.getAttribute && node.getAttribute('title'));
      push(node.getAttribute && node.getAttribute('aria-label'));
      push(node.getAttribute && node.getAttribute('data-name'));
      push(node.getAttribute && node.getAttribute('data-filename'));
    }

    const leafNodes = Array.from(row.querySelectorAll('span, div, p, a, strong, td'))
      .filter((el) => el && el.childElementCount === 0)
      .map((el) => el.textContent);
    for (const value of leafNodes) {
      push(value);
    }

    const rowText = String(row.innerText || row.textContent || '');
    for (const line of rowText.split(/\n+/)) {
      push(line);
    }

    return Array.from(out);
  }

  function extractNameFromRow(row) {
    if (!row) {
      return '';
    }
    const candidates = collectTextCandidates(row).sort((a, b) => b.length - a.length);
    return candidates[0] || '';
  }

  // =========================
  // 行 / 勾选框识别（复刻批量助手的通用选择器策略，适配光鸭云盘 DOM）
  // =========================
  function getRowSelector() {
    // 光鸭云盘文件行稳定特征：role=listitem / data-slot=row / .swangpan-file-list-table__row。
    // 不再用 [class*="file"]、[class*="item"] 等贪婪选择器——它们会把表头按钮
    // （类名含 file-list）和 titleCell/cell 误判成行。
    return [
      '.swangpan-file-list-table__row',
      '[data-slot="row"]',
      '[role="listitem"]',
      '[role="row"]',
      'tr',
      'li',
    ].join(', ');
  }

  function getClosestRow(node) {
    if (!node || typeof node.closest !== 'function') {
      return null;
    }
    return node.closest(getRowSelector());
  }

  function isHeaderOrToolbarNode(node) {
    return Boolean(
      node
      && typeof node.closest === 'function'
      && node.closest(
        '[data-slot="header"], .swangpan-file-list-table__header, .swangpan-file-list-table__headerCell, [data-slot="headerCell"], nav, [class*="toolbar"], [class*="breadcrumb"], [class*="crumb"], [class*="path"]'
      )
    );
  }

  function isLikelyListHeaderRow(row) {
    const text = normalizeDomName(row?.innerText || row?.textContent || '');
    if (!text) {
      return false;
    }
    return ['文件名称', '大小', '类型', '修改时间'].every((keyword) => text.includes(keyword)) && text.length <= 40;
  }

  function isUsableListRow(row) {
    if (!row || !isVisibleElement(row) || isHelperPanelNode(row) || isHeaderOrToolbarNode(row) || isLikelyListHeaderRow(row)) {
      return false;
    }
    // 行应当是容器型元素；按钮/图标/输入等显然不是文件行（避免把表头单元格、图标 span 当行）。
    const tag = row.tagName;
    if (tag === 'BUTTON' || tag === 'SVG' || tag === 'IMG' || tag === 'SPAN' || tag === 'LABEL' || tag === 'INPUT' || tag === 'A') {
      return false;
    }
    const text = normalizeDomName(row.innerText || row.textContent || '');
    return Boolean(text);
  }

  function isElementChecked(node) {
    if (!node) {
      return false;
    }
    if (node instanceof HTMLInputElement && node.type === 'checkbox') {
      return Boolean(node.checked);
    }
    const ariaChecked = node.getAttribute && node.getAttribute('aria-checked');
    if (ariaChecked === 'true') {
      return true;
    }
    if (ariaChecked === 'false') {
      return false;
    }
    const stateAttrs = [
      node.getAttribute?.('checked'),
      node.getAttribute?.('data-state'),
      node.getAttribute?.('data-selected'),
      node.getAttribute?.('data-checked'),
      node.getAttribute?.('aria-selected'),
    ].map((value) => String(value || '').toLowerCase()).filter(Boolean);
    if (stateAttrs.some((value) => ['true', 'checked', 'selected', 'on'].includes(value))) {
      return true;
    }
    if (stateAttrs.some((value) => ['false', 'unchecked', 'unselected', 'off'].includes(value))) {
      return false;
    }
    const className = String(node.className || '').toLowerCase();
    if (/(^|[\s:_-])(un|not)-?(checked|selected)([\s:_-]|$)/u.test(className)) {
      return false;
    }
    return /(^|[\s:_-])(?:is-)?checked([\s:_-]|$)/u.test(className)
      || /(^|[\s:_-])(?:is-)?selected([\s:_-]|$)/u.test(className)
      || /(^|[\s:_-])\w+-(?:checked|selected)([\s:_-]|$)/u.test(className);
  }

  function getCheckboxInRow(row) {
    if (!row) {
      return null;
    }
    const selectors = [
      'label.swangpan-checkbox__root',
      '.swangpan-checkbox__root',
      '[data-checkbox-control]',
      'label[role="checkbox"]',
      '[role="checkbox"]',
      '[aria-label*="选择"]',
      'button[aria-label*="选择"]',
      '[data-testid*="checkbox"]',
      '[class*="checkbox"]',
      '[class*="check"]',
      'input[type="checkbox"]',
    ];
    for (const selector of selectors) {
      const nodes = [];
      if (row.matches && row.matches(selector)) {
        nodes.push(row);
      }
      if (row.querySelectorAll) {
        nodes.push(...row.querySelectorAll(selector));
      }
      for (const node of nodes) {
        if (isVisibleElement(node)) {
          return node;
        }
      }
    }
    return null;
  }

  function guessRowIsDirectory(row, name = '') {
    if (!row) {
      return false;
    }
    // 正向文件夹证据：文件夹图标（光鸭云盘用 aria-label="typefolder" / class *-typefolder）。
    const folderIconSelectors = [
      '[aria-label="typefolder"]',
      '[aria-label*="folder" i]',
      '[class*="typefolder"]',
      '[class*="folder-icon"]',
      '[class*="dir-icon"]',
      '[data-type*="folder" i]',
      '[data-kind*="folder" i]',
      '[aria-label*="文件夹"]',
      '[title*="文件夹"]',
      'img[alt*="folder" i]',
      'img[alt*="文件夹"]',
    ];
    for (const selector of folderIconSelectors) {
      if (row.querySelector(selector)) {
        return true;
      }
    }
    // 类型单元格里的“文件夹”文本。
    const textCandidates = collectTextCandidates(row);
    if (textCandidates.some((text) => /^(文件夹|folder|directory)$/iu.test(text))) {
      return true;
    }
    // 正向文件证据：有扩展名 / 有缩略图 / 有大小。
    if (getExt(name)) {
      return false;
    }
    if (row.querySelector('img')) {
      return false;
    }
    if (extractSizeTextFromRow(row)) {
      return false;
    }
    // 既无文件夹证据、也无文件证据时，默认按文件处理——避免把图标文本、
    // 表头残留等无扩展名的杂项误判成文件夹。
    return false;
  }

  function getListRows() {
    return Array.from(document.querySelectorAll(getRowSelector())).filter((node) => isUsableListRow(node));
  }

  // 收集当前目录所有可见行及其勾选状态。
  function collectVisibleRows() {
    const out = [];
    const seen = new Set();
    for (const row of getListRows()) {
      const name = extractNameFromRow(row);
      const normalizedName = normalizeDomName(name);
      if (!isProbablyUsefulName(name) || !normalizedName || seen.has(normalizedName)) {
        continue;
      }
      seen.add(normalizedName);
      const checkbox = getCheckboxInRow(row);
      out.push({
        row,
        name,
        normalizedName,
        checkbox,
        checked: Boolean(checkbox && isElementChecked(checkbox)),
        isDir: guessRowIsDirectory(row, name),
        sizeText: extractSizeTextFromRow(row),
      });
    }
    return out;
  }

  // =========================
  // 当前目录上下文（parentId 来自抓包；显示名来自面包屑）
  // =========================
  function getCurrentDirectoryDisplayName() {
    // 光鸭云盘面包屑：<nav><ol><li title="目录名"><a>目录名</a></li>…</ol></nav>
    // 注意：类名是哈希（无 breadcrumb/crumb/path），也没有 aria-current；
    // 但目录项 li 都带 title 属性，而分隔符 li（next 图标）和 moreactions 下拉 li 都没有 title。
    // 所以“含 next 分隔图标的 nav 里的最后一个 li[title]”就是当前目录。
    const candidateNavs = Array.from(document.querySelectorAll('nav')).filter((nav) =>
      nav.querySelector('li[title]') && nav.querySelector('.swangpan-icon-next, [aria-label="next"]')
    );
    const nav = candidateNavs.length ? candidateNavs[candidateNavs.length - 1] : null;
    const liNodes = nav
      ? Array.from(nav.querySelectorAll('li[title]'))
      : Array.from(document.querySelectorAll('nav ol li[title]'));
    for (let i = liNodes.length - 1; i >= 0; i -= 1) {
      const node = liNodes[i];
      const text = normalizeDomName(node.getAttribute('title') || node.textContent || '')
        .replace(/\s*[-|｜丨]\s*光鸭云盘.*$/u, '')
        .trim();
      if (text) {
        return text;
      }
    }

    // 通用回退：其他云盘常见的面包屑写法（aria-current / breadcrumb 类名）。
    const selectors = [
      '[aria-label*="breadcrumb" i] [aria-current="page"]',
      '[class*="breadcrumb"] [aria-current="page"]',
      '[class*="crumb"] [aria-current="page"]',
      '[class*="breadcrumb"] [class*="item"]:last-child',
      '[class*="crumb"] [class*="item"]:last-child',
      '[class*="path"] [class*="name"]:last-child',
      '[class*="path"] [class*="item"]:last-child',
      'nav [aria-current="page"]',
    ];
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes.reverse()) {
        const text = normalizeDomName(node.textContent || node.innerText || '')
          .replace(/\s*[-|｜丨]\s*光鸭云盘.*$/u, '')
          .trim();
        if (text) {
          return text;
        }
      }
    }

    const title = normalizeDomName(document.title || '')
      .replace(/\s*[-|｜丨]\s*光鸭云盘.*$/u, '')
      .trim();
    if (title && !/^(光鸭云盘|首页|我的网盘)$/u.test(title)) {
      return title;
    }
    return '(当前目录)';
  }

  function refreshCurrentDir() {
    const parentId = String(STATE.currentDir.parentId || '').trim();
    STATE.currentDir.name = getCurrentDirectoryDisplayName();
    STATE.currentDir.url = String(location.href || '');
    if (parentId) {
      const bucket = STATE.capturedByDir[parentId];
      if (bucket && !bucket.name) {
        bucket.name = STATE.currentDir.name;
      }
    }
  }

  function getCurrentDirKey() {
    const parentId = String(STATE.currentDir.parentId || '').trim();
    return parentId || `url:${STATE.currentDir.url || location.href}`;
  }

  function getCurrentDirName() {
    const parentId = String(STATE.currentDir.parentId || '').trim();
    if (parentId && STATE.capturedByDir[parentId]?.name) {
      return STATE.capturedByDir[parentId].name;
    }
    return STATE.currentDir.name || '(当前目录)';
  }

  // =========================
  // API 抓取：注入页面上下文的 fetch/XHR 钩子（独立命名空间）
  // =========================
  function normalizeItem(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return null;
    }
    const fileId = obj.fileId ?? obj.id ?? obj.resourceId ?? obj.resId ?? obj.dirId ?? obj.dir_id ?? obj.folderId ?? obj.folder_id;
    const name = chooseBestName(obj);
    if ((typeof fileId !== 'string' && typeof fileId !== 'number') || typeof name !== 'string') {
      return null;
    }
    const sizeRaw = obj.size ?? obj.fileSize ?? obj.file_size ?? obj.bytes ?? obj.length ?? obj.resourceSize ?? obj.res_size;
    return {
      fileId: String(fileId),
      name,
      isDir: guessItemIsDirectory(obj, name),
      size: typeof sizeRaw === 'number' ? sizeRaw : null,
      parentId: String(obj.parentId ?? obj.parent_id ?? obj.pid ?? ''),
    };
  }

  function chooseBestName(obj) {
    const keys = [
      'name', 'fileName', 'file_name', 'filename', 'resName', 'resourceName',
      'title', 'displayName', 'display_name', 'originalName', 'original_name',
      'fileFullName', 'fullName', 'dirName', 'dir_name', 'folderName', 'folder_name',
    ];
    for (const key of keys) {
      if (typeof obj[key] === 'string' && obj[key].trim()) {
        return obj[key];
      }
    }
    return '';
  }

  function guessItemIsDirectory(obj, name = '') {
    // 光鸭云盘 get_file_list：resType 2 = 文件夹，1 = 文件。
    // 注意 dirType 在该接口里对文件/文件夹都为 1，不能用来判断是否目录。
    const resType = obj.resType ?? obj.res_type;
    if (resType != null) {
      const n = Number(resType);
      if (n === 2) {
        return true;
      }
      if (n === 1) {
        return false;
      }
    }
    const explicit = [obj.isDir, obj.is_dir, obj.isFolder, obj.is_folder, obj.folder, obj.directory, obj.dir]
      .map((v) => normalizeBooleanish(v))
      .find((v) => v != null);
    if (explicit != null) {
      return explicit;
    }
    const typeHints = [obj.itemType, obj.nodeType, obj.resourceType, obj.resType, obj.fileType, obj.type, obj.kind];
    for (const hint of typeHints) {
      if (hint == null || hint === '') {
        continue;
      }
      const text = String(hint).trim().toLowerCase();
      if (/(dir|folder|directory|catalog)/i.test(text)) {
        return true;
      }
      if (/(file|video|image|audio|doc|text|subtitle|torrent)/i.test(text)) {
        return false;
      }
    }
    // 有 fileSize / size / ext 的视为文件，否则按“无扩展名”视为文件夹。
    if (obj.fileSize != null || obj.size != null || obj.bytes != null || obj.length != null) {
      return false;
    }
    if (obj.ext) {
      return false;
    }
    return !getExt(name);
  }

  function normalizeBooleanish(value) {
    if (value === true || value === 1) {
      return true;
    }
    if (value === false || value === 0) {
      return false;
    }
    if (typeof value === 'string') {
      const text = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'on', 'checked', 'selected'].includes(text)) {
        return true;
      }
      if (['false', '0', 'no', 'n', 'off', 'unchecked', 'unselected'].includes(text)) {
        return false;
      }
    }
    return null;
  }

  function collectItemArrays(node, out = [], depth = 0, seen = new WeakSet()) {
    if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) {
      return out;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      const items = node.map((item) => normalizeItem(item)).filter(Boolean);
      if (items.length) {
        out.push(items);
      }
      for (const item of node) {
        if (item && typeof item === 'object') {
          collectItemArrays(item, out, depth + 1, seen);
        }
      }
      return out;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        collectItemArrays(value, out, depth + 1, seen);
      }
    }
    return out;
  }

  function extractItemsFromPayload(payload) {
    const arrays = collectItemArrays(payload);
    if (!arrays.length) {
      return [];
    }
    arrays.sort((a, b) => b.length - a.length);
    return arrays[0];
  }

  function looksLikeListRequest(url, requestBody) {
    if (typeof url === 'string' && /get_file_list|\/list/i.test(url)) {
      return true;
    }
    if (!requestBody || typeof requestBody !== 'object') {
      return false;
    }
    return ['parentId', 'pageSize', 'pageNum', 'pageNo', 'sortType', 'orderBy'].some((key) =>
      Object.prototype.hasOwnProperty.call(requestBody, key)
    );
  }

  function mergeCapturedItems(parentId, items) {
    const key = String(parentId || '').trim();
    if (!key) {
      return;
    }
    const bucket = STATE.capturedByDir[key] || { items: [], name: '', url: '', updatedAt: '' };
    const byName = new Map(bucket.items.map((item) => [normalizeDomName(item.name), item]));
    for (const item of items) {
      const nameKey = normalizeDomName(item.name);
      if (nameKey) {
        byName.set(nameKey, { ...byName.get(nameKey), ...item });
      }
    }
    bucket.items = Array.from(byName.values());
    bucket.updatedAt = new Date().toISOString();
    STATE.capturedByDir[key] = bucket;
  }

  function handleCapture(detail) {
    if (!detail || typeof detail !== 'object') {
      return;
    }
    const url = String(detail.url || '');
    const requestBody = safeJsonParse(detail.requestBody);
    const responseBody = safeJsonParse(detail.responseText);

    if (!looksLikeListRequest(url, requestBody)) {
      return;
    }

    const parentId = String((requestBody && requestBody.parentId) || '').trim();
    if (parentId) {
      STATE.currentDir.parentId = parentId;
      if (!STATE.capturedByDir[parentId]) {
        STATE.capturedByDir[parentId] = { items: [], name: getCurrentDirectoryDisplayName(), url: location.href, updatedAt: '' };
      }
    }

    if (responseBody && typeof responseBody === 'object') {
      const items = extractItemsFromPayload(responseBody);
      if (items.length) {
        mergeCapturedItems(parentId || STATE.currentDir.parentId, items);
        log(`已捕获目录 ${parentId || '(未知)'} 的文件列表：${items.length} 项。`);
      }
    }
  }

  function injectNetworkHook() {
    const code = `
      (() => {
        if (window[${JSON.stringify(HOOK_FLAG)}]) {
          return;
        }
        window[${JSON.stringify(HOOK_FLAG)}] = true;

        const EVENT_NAME = ${JSON.stringify(CAPTURE_EVENT)};
        const emit = (detail) => window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));

        const normalizeHeaders = (headersLike) => {
          const out = {};
          if (!headersLike) return out;
          if (headersLike instanceof Headers) {
            for (const [k, v] of headersLike.entries()) out[String(k).toLowerCase()] = v;
            return out;
          }
          if (Array.isArray(headersLike)) {
            for (const [k, v] of headersLike) out[String(k).toLowerCase()] = v;
            return out;
          }
          if (typeof headersLike === 'object') {
            for (const [k, v] of Object.entries(headersLike)) out[String(k).toLowerCase()] = v;
          }
          return out;
        };

        const shouldCapture = (url) => {
          if (typeof url !== 'string' || !url) return false;
          return /api\\.guangyapan\\.com|guangyapan\\.com/i.test(url);
        };

        const originalFetch = window.fetch.bind(window);
        window.fetch = async function patchedFetch(input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          const requestBody = init && typeof init.body === 'string' ? init.body : '';
          const response = await originalFetch(input, init);
          if (shouldCapture(url)) {
            try {
              const text = await response.clone().text();
              emit({ type: 'fetch', url, requestBody, responseText: text, status: response.status });
            } catch (err) {
              emit({ type: 'fetch', url, requestBody, responseText: '', status: response.status, error: String(err) });
            }
          }
          return response;
        };

        const rawOpen = XMLHttpRequest.prototype.open;
        const rawSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
          this.__gypCrossCapture = { method, url, requestBody: '' };
          return rawOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function patchedSend(body) {
          if (this.__gypCrossCapture && typeof body === 'string') {
            this.__gypCrossCapture.requestBody = body;
          }
          this.addEventListener('load', function onLoad() {
            const url = this.responseURL || (this.__gypCrossCapture && this.__gypCrossCapture.url) || '';
            if (!shouldCapture(url)) return;
            emit({
              type: 'xhr',
              url,
              requestBody: this.__gypCrossCapture ? this.__gypCrossCapture.requestBody : '',
              responseText: this.responseText || '',
              status: this.status,
            });
          });
          return rawSend.apply(this, arguments);
        };
      })();
    `;

    const script = document.createElement('script');
    script.textContent = code;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
  }

  // =========================
  // 解析勾选 -> 收集（镜像同步：当前目录可见行勾选则加入、取消则移除）
  // =========================
  function buildCapturedByName(parentId) {
    const map = new Map();
    const bucket = STATE.capturedByDir[String(parentId || '').trim()];
    if (!bucket) {
      return map;
    }
    for (const item of bucket.items) {
      const key = normalizeDomName(item.name);
      if (key && !map.has(key)) {
        map.set(key, item);
      }
    }
    return map;
  }

  function resolveItemFromRow(entry, capturedByName, dirCtx) {
    const name = String(entry.name || '');
    const normalizedName = normalizeDomName(name);
    const captured = capturedByName.get(normalizedName);
    const sizeText = captured && captured.size
      ? formatSizeFromBytes(captured.size)
      : entry.sizeText || '';
    return {
      id: `${dirCtx.dirKey}::${normalizedName}`,
      fileId: captured ? captured.fileId : '',
      name,
      // 优先用 API 捕获的 isDir（来自 resType，最可靠）；没捕获到时再用 DOM 推断。
      isDir: captured ? Boolean(captured.isDir) : entry.isDir,
      sizeText,
      dirKey: dirCtx.dirKey,
      dirName: dirCtx.dirName,
      dirParentId: dirCtx.dirParentId,
      dirUrl: dirCtx.dirUrl,
    };
  }

  function buildCurrentDirCtx() {
    refreshCurrentDir();
    return {
      dirKey: getCurrentDirKey(),
      dirName: getCurrentDirName(),
      dirParentId: String(STATE.currentDir.parentId || ''),
      dirUrl: String(STATE.currentDir.url || ''),
    };
  }

  // 增量同步：只把“当前目录可见且已勾选”的行加入收集，不主动移除任何记录。
  // 这样切换目录、刷新页面都不会丢失已收集的记录（取消勾选由事件针对性处理）。
  function additiveSyncCurrentDir() {
    if (STATE.scanning) {
      return;
    }
    if (STATE.paused) {
      return;
    }
    const dirCtx = buildCurrentDirCtx();
    const capturedByName = buildCapturedByName(dirCtx.dirParentId);
    const rows = collectVisibleRows();
    let changed = false;

    for (const entry of rows) {
      if (!entry.checked) {
        continue;
      }
      const item = resolveItemFromRow(entry, capturedByName, dirCtx);
      const existing = STATE.collected.get(item.id);
      if (!existing) {
        STATE.collected.set(item.id, { ...item, addedAt: Date.now() });
        changed = true;
      } else {
        const merged = { ...existing, ...item, addedAt: existing.addedAt };
        if (JSON.stringify(merged) !== JSON.stringify(existing)) {
          STATE.collected.set(item.id, merged);
          changed = true;
        }
      }
    }

    if (changed) {
      renderPanel();
      savePersistedDebounced();
    }
  }

  // 针对性移除：用户实际点击/切换了某一行勾选框且该行变为未勾选时，仅移除这一条记录。
  function removeIfUnchecked(target) {
    log('removeIfUnchecked', target);
    if (!target) {
      return;
    }
    const row = getClosestRow(target);
    if (!row || !isUsableListRow(row)) {
      return;
    }
    const checkbox = getCheckboxInRow(row);
    if (!checkbox || isElementChecked(checkbox)) {
      return;
    }
    const name = extractNameFromRow(row);
    const normalizedName = normalizeDomName(name);
    if (!normalizedName) {
      return;
    }
    const dirCtx = buildCurrentDirCtx();
    const id = `${dirCtx.dirKey}::${normalizedName}`;
    if (STATE.collected.has(id)) {
      removeItem(id);
    }
  }

  // =========================
  // 收集管理
  // =========================
  function removeItem(identity) {
    var item = STATE.collected.get(identity);
    if (!STATE.collected.delete(identity)) {
      return;
    }
    // 同步取消云盘页面中的勾选
    if (item && isCurrentDirItem(item)) {
      uncheckInPage(identity);
    }
    renderPanel();
    savePersistedDebounced();
  }

  // 判断 item 是否属于当前页面
  function isCurrentDirItem(item) {
    var currentKey = getCurrentDirKey();
    return Boolean(item && item.dirKey === currentKey);
  }

  // 在云盘页面中取消勾选指定文件
  function uncheckInPage(identity) {
    var parts = String(identity).split('::');
    if (parts.length < 2) return;
    var normalizedName = parts[parts.length - 1];
    var row = findRowByName(normalizedName);
    if (!row) return;
    var checkbox = getCheckboxInRow(row);
    if (!checkbox || !isElementChecked(checkbox)) return;
    // 模拟点击取消勾选
    if (typeof checkbox.click === 'function') {
      checkbox.click();
    } else {
      // 模拟触发 change 事件（兼容 Vercel 等 UI 框架）
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      // 尝试触发 Vercel 组件的事件
      var input = checkbox.querySelector('input[type="checkbox"]') || checkbox;
      if (input !== checkbox) {
        input.checked = false;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // 在当前页面中按名称查找文件行
  function findRowByName(name) {
    var normalizedName = normalizeDomName(name);
    if (!normalizedName) return null;
    var rows = getListRows();
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!isUsableListRow(row)) continue;
      var rowName = extractNameFromRow(row);
      if (normalizeDomName(rowName) === normalizedName) {
        return row;
      }
    }
    return null;
  }

  function clearGroup(dirKey) {
    let changed = false;
    for (const [identity, item] of STATE.collected) {
      if (item.dirKey === dirKey) {
        STATE.collected.delete(identity);
        changed = true;
      }
    }
    if (changed) {
      renderPanel();
      savePersistedDebounced();
    }
  }

  function clearAll() {
    if (!STATE.collected.size) {
      return;
    }
    STATE.collected.clear();
    renderPanel();
    savePersistedDebounced();
  }

  // =========================
  // 持久化
  // =========================
  function loadPersisted() {
    if (!CONFIG.persistAcrossReloads || typeof GM_getValue !== 'function') {
      return;
    }
    try {
      const raw = GM_getValue(STORAGE_KEY, '');
      const data = safeJsonParse(raw);
      if (Array.isArray(data)) {
        STATE.collected.clear();
        for (const item of data) {
          if (item && item.id) {
            STATE.collected.set(item.id, item);
          }
        }
        log(`已恢复 ${STATE.collected.size} 条跨目录勾选记录。`);
      }
    } catch (err) {
      log('恢复记录失败：', err);
    }
  }

  const savePersistedDebounced = debounce(() => {
    if (!CONFIG.persistAcrossReloads || typeof GM_setValue !== 'function') {
      return;
    }
    try {
      const data = Array.from(STATE.collected.values());
      GM_setValue(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      log('保存记录失败：', err);
    }
  }, CONFIG.saveDebounceMs);

  // =========================
  // 位置持久化
  // =========================
  function loadPanelPosition() {
    if (typeof GM_getValue !== 'function') {
      return { right: 16, top: 76 };
    }
    try {
      const pos = GM_getValue(POSITION_KEY, '');
      const data = safeJsonParse(pos);
      if (data && typeof data.right === 'number' && typeof data.top === 'number') {
        return { right: data.right, top: data.top };
      }
    } catch (err) {
      log('恢复位置失败：', err);
    }
    return { right: 16, top: 76 };
  }

  const savePanelPosition = debounce(() => {
    if (!UI.root || typeof GM_setValue !== 'function') {
      return;
    }
    const rect = UI.root.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const panelWidth = rect.width || 340;
    const panelHeight = rect.height || 400;
    // 将 right/top 限制在视口范围内
    const right = Math.max(0, Math.min(viewportWidth - rect.left - panelWidth, viewportWidth - 48));
    const top = Math.max(0, Math.min(rect.top, viewportHeight - 48));
    try {
      GM_setValue(POSITION_KEY, JSON.stringify({ right, top }));
    } catch (err) {
      log('保存位置失败：', err);
    }
  }, CONFIG.saveDebounceMs);

  // =========================
  // 浮窗 UI
  // =========================
  function createPanel() {
    if (UI.root || !document.body) {
      return;
    }

    const style = document.createElement('style');
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        right: 16px;
        top: 76px;
        z-index: 2147483646;
        width: 340px;
        max-width: calc(100vw - 24px);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #172033;
        user-select: none;
      }
      #${ROOT_ID} * {
        box-sizing: border-box;
      }
      #${ROOT_ID} .gypcs-panel {
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.97);
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
        backdrop-filter: blur(12px);
        overflow: hidden;
        transition: opacity 0.18s ease, transform 0.18s ease;
        transform-origin: top right;
      }
      #${ROOT_ID}.gypcs-collapsed .gypcs-panel {
        opacity: 0;
        transform: translateY(-8px) scale(0.96);
        pointer-events: none;
        height: 0;
      }
      #${ROOT_ID} .gypcs-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(15, 23, 42, 0.06);
        background: linear-gradient(180deg, #f6faff 0%, #ffffff 100%);
        cursor: grab;
      }
      #${ROOT_ID} .gypcs-head:active {
        cursor: grabbing;
      }
      #${ROOT_ID} .gypcs-title {
        font-size: 13px;
        font-weight: 700;
        flex: 1 1 auto;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${ROOT_ID} .gypcs-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 22px;
        height: 20px;
        padding: 0 6px;
        border-radius: 999px;
        background: #0f62fe;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
      }
      #${ROOT_ID} .gypcs-iconbtn {
        width: 26px;
        height: 26px;
        padding: 0;
        border: 1px solid rgba(15, 23, 42, 0.1);
        border-radius: 8px;
        background: #fff;
        color: #475569;
        font-size: 14px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s ease, color 0.15s ease;
      }
      #${ROOT_ID} .gypcs-iconbtn:hover {
        background: #eef2ff;
        color: #0f62fe;
      }
      #${ROOT_ID} .gypcs-status {
        padding: 6px 12px;
        font-size: 11px;
        color: #0f62fe;
        background: #eef4ff;
        display: none;
      }
      #${ROOT_ID} .gypcs-status.gypcs-show {
        display: block;
      }
      #${ROOT_ID} .gypcs-list {
        max-height: min(52vh, 560px);
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        padding: 4px 0;
      }
      #${ROOT_ID} .gypcs-list::-webkit-scrollbar {
        width: 8px;
      }
      #${ROOT_ID} .gypcs-list::-webkit-scrollbar-thumb {
        background: rgba(15, 23, 42, 0.18);
        border-radius: 999px;
      }
      #${ROOT_ID} .gypcs-group {
        border-bottom: 1px solid rgba(15, 23, 42, 0.05);
      }
      #${ROOT_ID} .gypcs-group:last-child {
        border-bottom: 0;
      }
      #${ROOT_ID} .gypcs-group-head {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px 4px;
        font-size: 11px;
        color: #64748b;
      }
      #${ROOT_ID} .gypcs-group-name {
        flex: 1 1 auto;
        min-width: 0;
        font-weight: 600;
        color: #334155;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${ROOT_ID} .gypcs-group-count {
        color: #94a3b8;
        font-weight: 600;
      }
      #${ROOT_ID} .gypcs-group-clear {
        border: 0;
        background: transparent;
        color: #94a3b8;
        cursor: pointer;
        font-size: 12px;
        padding: 0 2px;
      }
      #${ROOT_ID} .gypcs-group-clear:hover {
        color: #ef4444;
      }
      #${ROOT_ID} .gypcs-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 12px;
        font-size: 12px;
        line-height: 1.4;
      }
      #${ROOT_ID} .gypcs-item:hover {
        background: #f8fafc;
      }
      #${ROOT_ID} .gypcs-item-icon {
        flex: 0 0 auto;
        width: 16px;
        text-align: center;
      }
      #${ROOT_ID} .gypcs-item-name {
        flex: 1 1 auto;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: #1e293b;
      }
      #${ROOT_ID} .gypcs-item-size {
        flex: 0 0 auto;
        color: #94a3b8;
        font-size: 11px;
      }
      #${ROOT_ID} .gypcs-item-remove {
        flex: 0 0 auto;
        width: 20px;
        height: 20px;
        border: 0;
        background: transparent;
        color: #cbd5e1;
        cursor: pointer;
        border-radius: 6px;
        font-size: 13px;
        line-height: 1;
      }
      #${ROOT_ID} .gypcs-item-remove:hover {
        color: #ef4444;
        background: #fef2f2;
      }
      #${ROOT_ID} .gypcs-empty {
        padding: 28px 16px;
        text-align: center;
        color: #94a3b8;
        font-size: 12px;
        line-height: 1.6;
      }
      #${ROOT_ID} .gypcs-footer {
        display: flex;
        gap: 6px;
        padding: 8px 12px;
        border-top: 1px solid rgba(15, 23, 42, 0.06);
        background: #fbfcfe;
      }
      #${ROOT_ID} .gypcs-footer button {
        flex: 1 1 0;
        padding: 6px 4px;
        border: 1px solid rgba(15, 23, 42, 0.1);
        border-radius: 8px;
        background: #fff;
        color: #334155;
        font-size: 11px;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease;
      }
      #${ROOT_ID} .gypcs-footer button:hover {
        background: #eef2ff;
        color: #0f62fe;
      }
      #${ROOT_ID} .gypcs-footer button.gypcs-danger:hover {
        background: #fef2f2;
        color: #ef4444;
      }
      #${ROOT_ID} .gypcs-fab {
        display: none;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        border-radius: 999px;
        background: radial-gradient(circle at 30% 30%, #ffffff 0%, #edf5ff 100%);
        box-shadow: 0 12px 28px rgba(15, 98, 254, 0.22);
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
        color: #0f62fe;
      }
      #${ROOT_ID}.gypcs-collapsed .gypcs-fab {
        display: inline-flex;
      }
      #${ROOT_ID} .gypcs-fab:hover {
        transform: translateY(-1px);
      }
      #${ROOT_ID} .gypcs-fab-icon {
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.9);
        color: #0f62fe;
        font-size: 14px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s ease, color 0.15s ease;
      }
      #${ROOT_ID} .gypcs-fab-icon:hover {
        background: #fff;
        color: #0f62fe;
      }
      /* 目录选择器弹窗 */
      #gyp-folder-picker {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        background: rgba(0,0,0,.45);
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      #gyp-folder-picker .gyp-folder-modal {
        width: 480px;
        height: 560px;
        max-width: 92vw;
        max-height: 86vh;
        display: flex;
        flex-direction: column;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0,0,0,.3);
        overflow: hidden;
        color: #1f2937;
      }
      #gyp-folder-picker .gyp-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px;
        background: linear-gradient(135deg, #ff8a33, #ff6800);
        color: #fff;
        font-size: 15px;
        font-weight: 600;
      }
      #gyp-folder-picker .gyp-close {
        background: none;
        border: none;
        color: #fff;
        font-size: 24px;
        cursor: pointer;
        line-height: 1;
        padding: 0 4px;
      }
      #gyp-folder-picker .gyp-folder-path {
        padding: 8px 18px;
        background: #fff3e6;
        font-size: 12px;
        color: #6b7280;
        border-bottom: 1px solid #eee;
        word-break: break-all;
      }
      #gyp-folder-picker .gyp-tree {
        flex: 1;
        overflow-y: auto;
        padding: 6px 8px;
      }
      #gyp-folder-picker .gyp-fnode {
        list-style: none;
      }
      #gyp-folder-picker .gyp-frow {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 6px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
      }
      #gyp-folder-picker .gyp-frow:hover {
        background: #fff3e6;
      }
      #gyp-folder-picker .gyp-fnode.sel > .gyp-frow {
        background: #ffe6cc;
      }
      #gyp-folder-picker .gyp-fnode.sel > .gyp-frow .gyp-fname {
        color: #e65c00;
        font-weight: 600;
      }
      #gyp-folder-picker .gyp-toggle {
        width: 14px;
        text-align: center;
        color: #b1b1b1;
        cursor: pointer;
        flex-shrink: 0;
        user-select: none;
      }
      #gyp-folder-picker .gyp-toggle:hover {
        color: #ff6800;
      }
      #gyp-folder-picker .gyp-radio {
        width: 14px;
        height: 14px;
        border: 2px solid #d1d5db;
        border-radius: 50%;
        flex-shrink: 0;
        box-sizing: border-box;
      }
      #gyp-folder-picker .gyp-fnode.sel > .gyp-frow .gyp-radio {
        border-color: #ff6800;
        background: #ff6800;
        box-shadow: inset 0 0 0 2px #fff;
      }
      #gyp-folder-picker .gyp-ficon {
        font-size: 14px;
        flex-shrink: 0;
      }
      #gyp-folder-picker .gyp-fname {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      #gyp-folder-picker .gyp-fcount {
        color: #9ca3af;
        font-size: 11px;
        flex-shrink: 0;
      }
      #gyp-folder-picker .gyp-children {
        margin: 0;
        padding: 0;
      }
      #gyp-folder-picker .gyp-loading-row {
        list-style: none;
        padding: 6px 10px;
        color: #9ca3af;
        font-size: 12px;
      }
      #gyp-folder-picker .gyp-loading {
        text-align: center;
        padding: 50px 0;
        color: #6b7280;
      }
      #gyp-folder-picker .gyp-spinner {
        display: inline-block;
        width: 28px;
        height: 28px;
        border: 3px solid #e5e7eb;
        border-top-color: #ff6800;
        border-radius: 50%;
        animation: gypspin .8s linear infinite;
        margin-bottom: 12px;
      }
      @keyframes gypspin {
        to { transform: rotate(360deg); }
      }
      /* 解压进度条（作为文件行背景） */
      #${ROOT_ID} .gypcs-item {
        position: relative;
      }
      #${ROOT_ID} .gypcs-item-progress {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 0%;
        display: none;
        pointer-events: none;
        transition: width 0.3s ease;
        z-index: 0;
      }
      #${ROOT_ID} .gypcs-item-progress.gypcs-show {
        display: block;
      }
      #${ROOT_ID} .gypcs-item-progress .gypcs-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, rgba(15, 98, 254, 0.1), rgba(105, 32, 232, 0.1));
        position: absolute;
        left: 0;
        top: 0;
        right: 0;
        bottom: 0;
      }
      #${ROOT_ID} .gypcs-item .gypcs-progress-pct {
        font-size: 11px;
        color: #0f62fe;
        font-weight: 600;
        z-index: 1;
        position: relative;
      }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="gypcs-panel">
        <div class="gypcs-head">
          <span class="gypcs-title">光鸭快捷操作</span>
          <span class="gypcs-count" data-role="count">0</span>
          <button class="gypcs-iconbtn" data-action="pause" title="暂停监听">⏸</button>
          <button class="gypcs-iconbtn" data-action="collapse" title="收起">−</button>
        </div>
        <div class="gypcs-list" data-role="list"></div>
        <div class="gypcs-status" data-role="status"></div>
        <div class="gypcs-footer">
          <button data-action="scan">扫描勾选</button>
          <button data-action="decompress">批量解压</button>
          <button data-action="move">批量移动</button>
          <button data-action="delete" class="gypcs-danger">批量删除</button>
          <button data-action="clear" class="gypcs-danger">清空</button>
        </div>
      </div>
      <button class="gypcs-fab" data-action="expand">
        <button class="gypcs-fab-icon" data-action="toggle-pause" title="暂停监听">⏸</button>
        <span> 光鸭快捷操作</span>
        <span class="gypcs-count" data-role="fab-count">0</span>
      </button>
    `;
    document.body.appendChild(root);

    UI.root = root;
    UI.panel = root.querySelector('.gypcs-panel');
    UI.headerCount = root.querySelector('[data-role="count"]');
    UI.fabCount = root.querySelector('[data-role="fab-count"]');
    UI.statusEl = root.querySelector('[data-role="status"]');
    UI.listEl = root.querySelector('[data-role="list"]');

    // 应用上次保存的位置
    const savedPos = loadPanelPosition();
    // 使用 left/top 定位替代默认的 right 定位
    root.style.left = (window.innerWidth - savedPos.right - 340) + 'px';
    root.style.top = savedPos.top + 'px';

    root.addEventListener('click', onPanelClick);
    renderPanel();

    // 加载上次保存的暂停状态
    STATE.paused = loadPauseState();
    updatePauseButton();

    // 拖拽绑定到 header 和 FAB
    const header = root.querySelector('.gypcs-head');
    if (header) {
      header.addEventListener('mousedown', onDragStart);
    }
    const fab = root.querySelector('.gypcs-fab');
    if (fab) {
      fab.addEventListener('mousedown', onDragStart);
      const fabPauseBtn = fab.querySelector('[data-action="toggle-pause"]');
      if (fabPauseBtn) {
        fabPauseBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          togglePause();
        });
      }
    }
  }

  function onPanelClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target) {
      return;
    }
    const action = target.getAttribute('data-action');
    if (action === 'collapse') {
      setCollapsed(true);
    } else if (action === 'expand') {
      // 如果刚结束拖拽，忽略展开点击
      if (STATE.ignoreNextClick) {
        STATE.ignoreNextClick = false;
        return;
      }
      setCollapsed(false);
    } else if (action === 'scan') {
      scanCurrentDirectory();
    } else if (action === 'clear') {
      clearAll();
    } else if (action === 'remove-item') {
      const identity = target.getAttribute('data-id');
      if (identity) {
        removeItem(identity);
      }
    } else if (action === 'clear-group') {
      const dirKey = target.getAttribute('data-dir-key');
      if (dirKey) {
        clearGroup(dirKey);
      }
    } else if (action === 'pause') {
      togglePause();
    } else if (action === 'move') {
      batchMove();
    } else if (action === 'decompress') {
      batchDecompress();
    } else if (action === 'delete') {
      batchDelete();
    }
  }

  function togglePause() {
    STATE.paused = !STATE.paused;
    updatePauseButton();
    savePauseState();
    flashStatus(STATE.paused ? '已暂停监听' : '已恢复监听');
  }

  function updatePauseButton() {
    if (!UI.root) return;
    // 面板内的暂停按钮
    const pauseBtn = UI.root.querySelector('[data-action="pause"]');
    if (pauseBtn) {
      pauseBtn.textContent = STATE.paused ? '▶' : '⏸';
      pauseBtn.title = STATE.paused ? '恢复监听' : '暂停监听';
    }
    // FAB 按钮的暂停图标
    const fabPauseBtn = UI.root.querySelector('.gypcs-fab [data-action="toggle-pause"]');
    if (fabPauseBtn) {
      fabPauseBtn.textContent = STATE.paused ? '▶' : '⏸';
      fabPauseBtn.title = STATE.paused ? '恢复监听' : '暂停监听';
    }
  }

  function savePauseState() {
    if (typeof GM_setValue !== 'function') return;
    try {
      GM_setValue(POSITION_KEY + '_PAUSED', JSON.stringify(STATE.paused));
    } catch (e) {}
  }

  function loadPauseState() {
    if (typeof GM_getValue !== 'function') return false;
    try {
      const val = GM_getValue(POSITION_KEY + '_PAUSED', 'false');
      return JSON.parse(val);
    } catch (e) {
      return false;
    }
  }

  function setCollapsed(collapsed) {
    UI.collapsed = collapsed;
    if (UI.root) {
      UI.root.classList.toggle('gypcs-collapsed', collapsed);
    }
  }

  // =========================
  // 浮窗拖拽
  // =========================
  function onDragStart(event) {
    // 如果点击的是面板内的按钮/图标等可点击元素，不启动拖拽
    // 但 FAB 按钮本身是拖拽目标，需要额外判断
    const target = event.target;
    const isFab = target.classList?.contains('gypcs-fab') || target.closest('.gypcs-fab');
    const isPanelClickable = !isFab && (
      target.tagName === 'BUTTON' || target.tagName === 'A' ||
      target.closest('button[data-action]') || target.closest('a')
    );
    if (isPanelClickable) {
      return;
    }

    const root = UI.root;
    if (!root) return;

    STATE.dragging = true;
    STATE.dragStartX = event.clientX;
    STATE.dragStartY = event.clientY;
    STATE.dragMoved = false;
    const rect = root.getBoundingClientRect();
    STATE.dragOffsetX = event.clientX - rect.left;
    STATE.dragOffsetY = event.clientY - rect.top;

    // 绑定全局移动/释放事件
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(event) {
    if (!STATE.dragging) return;

    // 检测是否发生了实际的拖拽移动（超过5像素）
    const dx = Math.abs(event.clientX - STATE.dragStartX);
    const dy = Math.abs(event.clientY - STATE.dragStartY);
    if (dx > 5 || dy > 5) {
      STATE.dragMoved = true;
    }

    const root = UI.root;
    if (!root) return;

    const newX = event.clientX - STATE.dragOffsetX;
    const newY = event.clientY - STATE.dragOffsetY;

    // 限制在视口范围内
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    root.style.left = Math.max(0, Math.min(newX, viewportWidth - 48)) + 'px';
    root.style.top = Math.max(0, Math.min(newY, viewportHeight - 48)) + 'px';
  }

  function onDragEnd() {
    if (!STATE.dragging) return;
    STATE.dragging = false;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);

    // 只有在实际拖拽后才忽略随后的 click 事件，避免 FAB 触发展开
    if (STATE.dragMoved) {
      STATE.ignoreNextClick = true;
      setTimeout(() => { STATE.ignoreNextClick = false; }, 100);
    } else {
      // 纯点击不设置忽略标志
      STATE.ignoreNextClick = false;
    }
    STATE.dragMoved = false;

    savePanelPosition();
  }

  let statusTimer = null;
  function flashStatus(text) {
    if (!UI.statusEl) {
      return;
    }
    UI.statusEl.textContent = text;
    UI.statusEl.classList.add('gypcs-show');
    if (statusTimer) {
      clearTimeout(statusTimer);
    }
    statusTimer = setTimeout(() => {
      UI.statusEl.classList.remove('gypcs-show');
      UI.statusEl.textContent = '';
    }, 1800);
  }

  // =========================
  // 目录选择器（用于批量移动）
  // =========================
  function closeFolderPicker() {
    var p = document.getElementById('gyp-folder-picker');
    if (p) p.remove();
  }

  function fetchFileList(parentId) {
    return gmApiRequest('POST', FILE_LIST_URL, {
      page: 0,
      pageSize: 100,
      parentId: parentId == null ? '' : parentId,
      resType: 2,
      needSubFolderStat: true
    }).then(function (r) {
      var ret = parseApiResult(r);
      if (!ret.ok || !ret.json || !ret.json.data) {
        throw new Error(ret.msg || ('HTTP ' + r.status));
      }
      return (ret.json.data.list || []);
    });
  }

  function openFolderPicker(onConfirm) {
    closeFolderPicker();
    var overlay = document.createElement('div');
    overlay.id = 'gyp-folder-picker';
    overlay.innerHTML =
      '<div id="gyp-modal" class="gyp-folder-modal">' +
      '  <div class="gyp-header"><span>📁 选择保存目录</span><button class="gyp-close" title="关闭">×</button></div>' +
      '  <div class="gyp-folder-path"></div>' +
      '  <div class="gyp-body gyp-tree"><div class="gyp-loading"><div class="gyp-spinner"></div><br>正在加载目录…</div></div>' +
      '  <div class="gyp-footer" style="display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:12px 18px;border-top:1px solid #eee;background:#fafafa;">' +
      '    <span class="gyp-status" style="flex:1;font-size:12px;color:#6b7280;"></span>' +
      '    <button class="gyp-btn gyp-btn-ghost" style="padding:7px 16px;border:none;border-radius:6px;font-size:13px;cursor:pointer;background:#e5e7eb;color:#374151;" id="gyp-folder-cancel">取消</button>' +
      '    <button class="gyp-btn gyp-btn-primary" style="padding:7px 16px;border:none;border-radius:6px;font-size:13px;cursor:pointer;background:#ff6800;color:#fff;" id="gyp-folder-confirm" disabled>选择此目录</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(overlay);

    var tree = overlay.querySelector('.gyp-tree');
    var pathEl = overlay.querySelector('.gyp-folder-path');
    var confirmBtn = document.getElementById('gyp-folder-confirm');
    var statusEl = overlay.querySelector('.gyp-status');
    var picked = null;

    overlay.querySelector('.gyp-close').addEventListener('click', closeFolderPicker);
    document.getElementById('gyp-folder-cancel').addEventListener('click', closeFolderPicker);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeFolderPicker(); });
    confirmBtn.addEventListener('click', function () {
      if (picked) onConfirm(picked);
      closeFolderPicker();
    });

    function getPathOfNode(li) {
      if (li.dataset.id === '') return [];
      var path = [];
      var cur = li;
      while (cur && cur.classList && cur.classList.contains('gyp-fnode')) {
        path.unshift(cur.dataset.name);
        cur = cur.parentElement ? cur.parentElement.closest('.gyp-fnode') : null;
      }
      return path;
    }

    function selectNode(li) {
      var prev = tree.querySelectorAll('.gyp-fnode.sel');
      Array.prototype.forEach.call(prev, function (n) { n.classList.remove('sel'); });
      li.classList.add('sel');
      var path = getPathOfNode(li);
      picked = { id: li.dataset.id, name: li.dataset.name, path: path };
      pathEl.textContent = path.length ? path.join(' / ') : li.dataset.name;
      confirmBtn.disabled = false;
      statusEl.textContent = '';
    }

    function wireNode(li) {
      var row = li.querySelector('.gyp-frow');
      var toggle = li.querySelector('.gyp-toggle');
      row.addEventListener('click', function (e) {
        if (e.target === toggle) return;
        selectNode(li);
      });
      if (toggle) {
        toggle.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!toggle.textContent.trim()) return;
          toggleNode(li);
        });
      }
    }

    function makeNode(f, depth) {
      var hasChild = (Number(f.subFolderCount) || 0) > 0;
      var li = document.createElement('li');
      li.className = 'gyp-fnode';
      li.dataset.id = f.fileId;
      li.dataset.name = f.fileName;
      li.dataset.depth = depth;
      li.dataset.loaded = '0';
      li.dataset.expanded = '0';
      li.innerHTML =
        '<div class="gyp-frow" style="padding-left:' + (depth * 18 + 8) + 'px">' +
        '<span class="gyp-toggle">' + (hasChild ? '▶' : '') + '</span>' +
        '<span class="gyp-radio"></span>' +
        '<span class="gyp-ficon">📁</span>' +
        '<span class="gyp-fname" title="' + escapeHtml(f.fileName) + '">' + escapeHtml(f.fileName) + '</span>' +
        '<span class="gyp-fcount">' + (hasChild ? f.subFolderCount : '') + '</span>' +
        '</div>' +
        '<ul class="gyp-children" style="display:none"></ul>';
      wireNode(li);
      return li;
    }

    function renderNodes(container, folders, depth) {
      folders.forEach(function (f) { container.appendChild(makeNode(f, depth)); });
    }

    function loadChildren(li) {
      var children = li.querySelector('.gyp-children');
      var toggle = li.querySelector('.gyp-toggle');
      var depth = parseInt(li.dataset.depth, 10) + 1;
      children.innerHTML = '<li class="gyp-loading-row">加载中…</li>';
      children.style.display = '';
      toggle.textContent = '⏳';
      fetchFileList(li.dataset.id).then(function (folders) {
        children.innerHTML = '';
        li.dataset.loaded = '1';
        li.dataset.expanded = '1';
        if (folders.length === 0) { toggle.textContent = ''; return; }
        toggle.textContent = '▼';
        renderNodes(children, folders, depth);
      }).catch(function (e) {
        children.innerHTML = '<li class="gyp-loading-row" style="color:#dc2626;">加载失败：' + escapeHtml(e.message) + '</li>';
        toggle.textContent = '▶';
        li.dataset.loaded = '0';
      });
    }

    function toggleNode(li) {
      var children = li.querySelector('.gyp-children');
      var toggle = li.querySelector('.gyp-toggle');
      if (li.dataset.expanded === '1') {
        children.style.display = 'none';
        toggle.textContent = '▶';
        li.dataset.expanded = '0';
      } else if (li.dataset.loaded === '1') {
        children.style.display = '';
        toggle.textContent = '▼';
        li.dataset.expanded = '1';
      } else {
        loadChildren(li);
      }
    }

    // 加载根目录列表
    fetchFileList('').then(function (folders) {
      tree.innerHTML = '';
      renderNodes(tree, folders, 0);
    }).catch(function (e) {
      tree.innerHTML = '<div style="padding:30px 10px;color:#dc2626;text-align:center;">❌ 目录加载失败：' + escapeHtml(e.message) + '</div>';
      statusEl.textContent = '加载失败，请检查 Token';
      statusEl.style.color = '#dc2626';
    });
  }

  // =========================
  // 批量移动功能
  // =========================
  function batchMove() {
    var items = Array.from(STATE.collected.values());
    if (!items.length) {
      flashStatus('没有已选文件，无法移动');
      return;
    }

    // 收集所有有 fileId 的文件
    var fileItems = items.filter(function (item) { return item.fileId && String(item.fileId).trim(); });
    if (!fileItems.length) {
      flashStatus('勾选的文件未获取到 ID，请先扫描当前目录');
      return;
    }

    // 打开目录选择器
    openFolderPicker(function (picked) {
      var fileIds = fileItems.map(function (item) { return item.fileId; });

      // 显示状态
      flashStatus('正在移动文件…');

      gmApiRequest('POST', MOVE_FILE_URL, {
        fileIds: fileIds,
        parentId: picked.id
      }).then(function (r) {
        var ret = parseApiResult(r);
        if (!ret.ok || !ret.json || !ret.json.data || !ret.json.data.taskId) {
          flashStatus('移动失败：' + (ret.msg || '未知错误'));
          return;
        }

        var taskId = ret.json.data.taskId;
        flashStatus('移动任务已创建，等待完成…');

        // 轮询任务状态
        pollTaskStatus(taskId, function (success, errorMsg) {
          if (success) {
            // 移动成功，从收集结果中移除已移动的文件
            var removedCount = 0;
            fileItems.forEach(function (item) {
              if (STATE.collected.has(item.id)) {
                STATE.collected.delete(item.id);
                removedCount++;
              }
            });
            renderPanel();
            savePersistedDebounced();
            flashStatus('✅ 成功移动 ' + removedCount + ' 个文件到：' + picked.name);
          } else {
            flashStatus('移动失败：' + errorMsg);
          }
        });
      }).catch(function (e) {
        flashStatus('移动请求失败：' + e.message);
      });
    });
  }

  function pollTaskStatus(taskId, callback) {
    var maxAttempts = CONFIG.move.taskPollMaxTries;
    var pollInterval = CONFIG.move.taskPollMs;
    var attempt = 0;

    function check() {
      attempt++;
      gmApiRequest('POST', TASK_STATUS_URL, { taskId: taskId }).then(function (r) {
        var ret = parseApiResult(r);
        if (!ret.ok || !ret.json || !ret.json.data) {
          callback(false, ret.msg || '获取任务状态失败');
          return;
        }

        var status = ret.json.data.status;

        if (status === 2) {
          // 状态 2 = 已完成
          callback(true);
        } else {
          // 状态 1 = 进行中（可能有 progress 字段），继续轮询
          if (attempt >= maxAttempts) {
            callback(false, '等待超时');
            return;
          }
          setTimeout(check, pollInterval);
        }
      }).catch(function (e) {
        callback(false, e.message);
      });
    }

    check();
  }

  // =========================
  // 批量删除功能
  // =========================
  function batchDelete() {
    var items = Array.from(STATE.collected.values());
    if (!items.length) {
      flashStatus('没有已选文件，无法删除');
      return;
    }

    // 收集所有有 fileId 的文件
    var fileItems = items.filter(function (item) { return item.fileId && String(item.fileId).trim(); });
    if (!fileItems.length) {
      flashStatus('勾选的文件未获取到 ID，请先扫描当前目录');
      return;
    }

    // 二次确认
    var name = fileItems.length === 1 ? '"' + fileItems[0].name + '"' : '共 ' + fileItems.length + ' 个文件';
    if (!confirm('确定要删除以下文件吗？\n\n' + name)) {
      return;
    }

    flashStatus('正在删除文件…');

    gmApiRequest('POST', DELETE_FILE_URL, {
      fileIds: fileItems.map(function (item) { return item.fileId; })
    }).then(function (r) {
      var ret = parseApiResult(r);
      if (!ret.ok || !ret.json || !ret.json.data || !ret.json.data.taskId) {
        flashStatus('删除失败：' + (ret.msg || '未知错误'));
        return;
      }

      var taskId = ret.json.data.taskId;
      flashStatus('删除任务已创建，等待完成…');

      pollTaskStatus(taskId, function (success) {
        if (success) {
          // 删除成功，从收集结果中移除已删除的文件
          var removedCount = 0;
          fileItems.forEach(function (item) {
            if (STATE.collected.has(item.id)) {
              STATE.collected.delete(item.id);
              removedCount++;
            }
          });
          renderPanel();
          savePersistedDebounced();
          flashStatus('✅ 成功删除 ' + removedCount + ' 个文件');
        } else {
          flashStatus('删除失败：等待任务完成超时');
        }
      });
    }).catch(function (e) {
      flashStatus('删除请求失败：' + e.message);
    });
  }

  // =========================
  // 解压进度轮询
  // =========================
  function pollDecompressStatus(taskId, taskInfo) {
    const pollInterval = CONFIG.move.taskPollMs;

    function check() {
      gmApiRequest('POST', DECOMPRESS_STATUS_URL, { taskId: taskId }).then(function (r) {
        var ret = parseApiResult(r);
        log('查询解压进度', ret)
        if (!ret.ok || !ret.json || !ret.json.data) {
          taskInfo.text = '解压失败：' + (ret.msg || '未知错误');
          taskInfo.progress = 100;
          renderPanel();
          return;
        }

        var data = ret.json.data;
        var progress = 0;
        var text = '';

        if (data != null) {
          progress = data.progress ? Number(data.progress) || 0 : 0;
          text = progress + '%';

          // 解压完成：status = 2 或 progress = 100
          var isCompleted = data.status === 2 || progress >= 100;
          log("解压是否完成", isCompleted)
          if (isCompleted) {
            // 从收集列表中移除已解压的文件
            if (taskInfo.completed) {
              var removedCount = 0;
              taskInfo.completed.forEach(function (identity) {
                if (STATE.collected.has(identity)) {
                  STATE.collected.delete(identity);
                  removedCount++;
                }
              });
              renderPanel();
              savePersistedDebounced();
              flashStatus('✅ 成功解压 ' + removedCount + ' 个文件');
            }
            STATE.decompressTasks.delete(taskId);
            return;
          }
        }

        taskInfo.progress = progress;
        taskInfo.text = text;
        renderPanel();
        setTimeout(check, pollInterval);
      }).catch(function (e) {
        taskInfo.text = '查询进度失败：' + e.message;
        taskInfo.progress = 100;
        renderPanel();
      });
    }

    check();
  }

  // =========================
  // 批量解压功能
  // =========================
  function isArchiveFile(name) {
    var archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'zst', 'iso', 'cab', 'arj', 'lzh', 'lz', 'zstd'];
    var ext = getExt(name);
    return archiveExts.indexOf(ext) !== -1;
  }

  function batchDecompress() {
    var items = Array.from(STATE.collected.values());
    if (!items.length) {
      flashStatus('没有已选文件，无法解压');
      return;
    }

    // 筛选出压缩文件
    var archiveItems = items.filter(function (item) { return isArchiveFile(item.name); });
    if (!archiveItems.length) {
      flashStatus('没有压缩文件，无法解压');
      return;
    }

    // 收集所有有 fileId 的压缩文件
    var fileItems = archiveItems.filter(function (item) { return item.fileId && String(item.fileId).trim(); });
    if (!fileItems.length) {
      flashStatus('压缩文件未获取到 ID，请先扫描当前目录');
      return;
    }

    // 打开目录选择器（选择保存目录）
    openFolderPicker(function (picked) {
      // 串行解压：逐个处理压缩文件
      var queue = fileItems.slice();
      var currentIndex = 0;
      var total = queue.length;

      function processNext() {
        if (queue.length === 0) {
          flashStatus('✅ 全部解压完成');
          return;
        }

        var currentItem = queue.shift();
        currentIndex++;
        flashStatus('正在创建解压任务 (' + currentIndex + '/' + total + ')…');

        gmApiRequest('POST', DECOMPRESS_URL, {
          fileId: currentItem.fileId,
          password: '',
          filePaths: [],
          toFileId: picked.id
        }).then(function (r) {
          var ret = parseApiResult(r);
          if (!ret.ok || !ret.json || !ret.json.data || !ret.json.data.taskId) {
            flashStatus('创建解压任务失败：' + (ret.msg || '未知错误'));
            processNext();
            return;
          }

          var taskId = ret.json.data.taskId;
          flashStatus('解压任务 ' + currentIndex + '/' + total + ' 已创建，等待完成…');

          // 记录解压任务进度
          var taskInfo = {
            decompressing: true,
            taskId: taskId,
            itemIdentity: currentItem.id,
            fileName: currentItem.name,
            progress: 0,
            text: currentItem.name + ' 解压中... 0%'
          };
          STATE.decompressTasks.set(taskId, taskInfo);
          renderPanel();

          // 开始轮询解压进度
          pollDecompressStatus(taskId, taskInfo, function () {
            // 回调：当前任务完成，继续下一个
            processNext();
          });
        }).catch(function (e) {
          flashStatus('解压请求失败：' + e.message);
          processNext();
        });
      }

      processNext();
    });
  }

  function pollDecompressStatus(taskId, taskInfo, onComplete) {
    var pollInterval = CONFIG.move.taskPollMs;

    function check() {
      gmApiRequest('POST', DECOMPRESS_STATUS_URL, { taskId: taskId }).then(function (r) {
        var ret = parseApiResult(r);
        if (!ret.ok || !ret.json || !ret.json.data) {
          taskInfo.text = '查询进度失败：' + (ret.msg || '未知错误');
          taskInfo.progress = 100;
          renderPanel();
          onComplete();
          return;
        }

        var data = ret.json.data;
        var progress = 0;
        var text = taskInfo.fileName + ' 解压中... ' + progress + '%';

        if (data != null) {
          progress = Number(data.progress) || 0;
          text = data.statusText || data.message || (taskInfo.fileName + ' 解压中... ' + progress + '%');

          // 解压完成：status = 2 或 progress = 100
          var isCompleted = data.status === 2 || progress >= 100;
          log("解压是否完成", isCompleted);
          if (isCompleted) {
            // 从收集列表中移除已解压的文件
            var removedCount = 0;
            if (taskInfo.itemIdentity && STATE.collected.has(taskInfo.itemIdentity)) {
              STATE.collected.delete(taskInfo.itemIdentity);
              removedCount++;
            }
            if (removedCount > 0) {
              renderPanel();
              savePersistedDebounced();
            }
            flashStatus('✅ 成功解压 ' + taskInfo.fileName);
            STATE.decompressTasks.delete(taskId);
            onComplete();
            return;
          } else {
            flashStatus(text);
          }
        }

        taskInfo.progress = progress;
        taskInfo.text = text;
        renderPanel();
        setTimeout(check, pollInterval);
      }).catch(function (e) {
        taskInfo.text = '查询进度失败：' + e.message;
        taskInfo.progress = 100;
        renderPanel();
        onComplete();
      });
    }

    check();
  }

  function renderPanel() {
    if (!UI.root) {
      return;
    }
    const items = Array.from(STATE.collected.values());

    // 按目录分组，保持首次加入顺序。
    const groups = new Map();
    for (const item of items) {
      const key = item.dirKey || '(未知目录)';
      if (!groups.has(key)) {
        groups.set(key, { dirKey: key, dirName: item.dirName || '(未知目录)', dirUrl: item.dirUrl || '', items: [] });
      }
      groups.get(key).items.push(item);
    }

    const signature = items.length + '|' + Array.from(groups.keys()).join('>') + '|' + items.map((i) => i.id).join(',');
    if (signature === STATE.lastSignature) {
      return;
    }
    STATE.lastSignature = signature;

    if (UI.headerCount) {
      UI.headerCount.textContent = String(items.length);
    }
    if (UI.fabCount) {
      UI.fabCount.textContent = String(items.length);
    }

    if (!items.length) {
      UI.listEl.innerHTML = `<div class="gypcs-empty">尚无跨目录勾选记录。<br>在文件列表中勾选文件 / 文件夹，<br>切换目录后记录会保留在此处。</div>`;
      return;
    }

    const html = Array.from(groups.values()).map((group) => {
      const itemHtml = group.items.map((item) => {
        const icon = item.isDir ? '📁' : '📄';

        // 检查该文件是否正在解压中
        var decompressTask = null;
        for (var task of STATE.decompressTasks.values()) {
          if (task.decompressing && task.itemIdentity === item.id) {
            decompressTask = task;
            break;
          }
        }

        var progressBgHtml = '';
        if (decompressTask) {
          var progress = Math.min(100, Math.max(0, Number(decompressTask.progress) || 0));
          progressBgHtml = `
            <span class="gypcs-item-progress gypcs-show" style="width:${progress}%"></span>
            <span class="gypcs-progress-pct">${progress}%</span>
          `;
        }

        return `
          <div class="gypcs-item">
            <span class="gypcs-item-icon">${icon}</span>
            <span class="gypcs-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            ${progressBgHtml || (item.sizeText ? `<span class="gypcs-item-size">${escapeHtml(item.sizeText)}</span>` : '')}
            <button class="gypcs-item-remove" data-action="remove-item" data-id="${escapeHtml(item.id)}" title="移除">✕</button>
          </div>
        `;
      }).join('');
      return `
        <div class="gypcs-group">
          <div class="gypcs-group-head">
            <span>📂</span>
            <span class="gypcs-group-name" title="${escapeHtml(group.dirUrl || group.dirName)}">${escapeHtml(group.dirName)}</span>
            <span class="gypcs-group-count">${group.items.length}</span>
            <button class="gypcs-group-clear" data-action="clear-group" data-dir-key="${escapeHtml(group.dirKey)}" title="清空该目录">✕</button>
          </div>
          ${itemHtml}
        </div>
      `;
    }).join('');

    UI.listEl.innerHTML = html;
  }

  function mountPanelWhenReady() {
    if (UI.root) {
      return;
    }
    if (document.body) {
      createPanel();
      return;
    }
    const tryMount = () => {
      if (document.body && !UI.root) {
        createPanel();
      }
    };
    document.addEventListener('DOMContentLoaded', tryMount, { once: true });
    window.addEventListener('load', tryMount, { once: true });
    const timer = window.setInterval(() => {
      if (UI.root) {
        window.clearInterval(timer);
        return;
      }
      if (document.body) {
        createPanel();
        window.clearInterval(timer);
      }
    }, 300);
  }

  // =========================
  // 扫描勾选：自动滚动，让虚拟列表里的每一行都经过可见区，从而被同步到。
  // =========================
  function findScrollableListContainer() {
    const rows = getListRows().filter(isVisibleElement).slice(0, 12);
    const scored = [];
    for (const row of rows) {
      let current = row.parentElement;
      while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        const overflowY = style ? style.overflowY : '';
        const canScroll =
          current.scrollHeight > current.clientHeight + 40 &&
          /(auto|scroll|overlay)/i.test(String(overflowY || ''));
        if (canScroll) {
          scored.push({ node: current, score: current.scrollHeight - current.clientHeight });
        }
        current = current.parentElement;
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.node || document.scrollingElement || document.documentElement;
  }

  async function scanCurrentDirectory() {
    if (STATE.scanning) {
      return;
    }
    STATE.scanning = true;
    flashStatus('正在扫描勾选项…');
    const container = findScrollableListContainer();
    const isDoc = container === document.scrollingElement || container === document.documentElement || container === document.body;
    const startScroll = isDoc ? (window.scrollY || 0) : container.scrollTop;
    const deltaY = Math.max(280, Math.floor((container?.clientHeight || window.innerHeight || 640) * 0.72));
    try {
      if (isDoc) {
        window.scrollTo({ top: 0, behavior: 'auto' });
      } else if (container) {
        container.scrollTop = 0;
      }
      await sleep(CONFIG.scanScrollDelayMs);
      for (let round = 0; round < CONFIG.scanMaxRounds; round += 1) {
        additiveSyncCurrentDir();
        const moved = await scrollOneStep(container, deltaY);
        if (!moved) {
          break;
        }
        await sleep(CONFIG.scanScrollDelayMs);
      }
      additiveSyncCurrentDir();
      flashStatus('扫描完成');
    } finally {
      if (isDoc) {
        window.scrollTo({ top: startScroll, behavior: 'auto' });
      } else if (container) {
        container.scrollTop = startScroll;
      }
      STATE.scanning = false;
    }
  }

  function scrollOneStep(container, deltaY) {
    if (!container) {
      return Promise.resolve(false);
    }
    const isDoc = container === document.scrollingElement || container === document.documentElement || container === document.body;
    if (isDoc) {
      const before = window.scrollY || 0;
      window.scrollTo({ top: before + deltaY, behavior: 'auto' });
      return Promise.resolve(Math.abs((window.scrollY || 0) - before) > 1);
    }
    const before = container.scrollTop;
    container.scrollTop = before + deltaY;
    return Promise.resolve(Math.abs(container.scrollTop - before) > 1);
  }

  // =========================
  // 事件监听
  // =========================
  // 事件触发的同步：防抖，避免快速点击时堆积。
  const debouncedEventSync = debounce(() => {
    additiveSyncCurrentDir();
  }, 120);

  function onDocInteraction(event) {
    if (STATE.paused) {
      return;
    }
    const target = event.target;
    if (!target || isHelperPanelNode(target)) {
      return;
    }
    // 勾选框变化后，页面框架通常需要一拍才更新 aria-checked / class，延后一帧再处理。
    window.setTimeout(() => {
      removeIfUnchecked(target);
      debouncedEventSync();
    }, 0);
  }

  function installListeners() {
    document.addEventListener('click', onDocInteraction, true);
    document.addEventListener('change', onDocInteraction, true);
    window.addEventListener(CAPTURE_EVENT, (event) => handleCapture(event.detail));
    STATE.pollTimer = window.setInterval(additiveSyncCurrentDir, CONFIG.pollIntervalMs);
  }

  // =========================
  // 菜单
  // =========================
  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') {
      return;
    }
    GM_registerMenuCommand('光鸭快捷操作：立即同步当前目录', () => {
      additiveSyncCurrentDir();
      flashStatus('已同步');
    });
    GM_registerMenuCommand('光鸭快捷操作：扫描当前目录全部勾选', () => {
      scanCurrentDirectory();
    });
  }

  // =========================
  // 启动
  // =========================
  function start() {
    loadPersisted();
    injectNetworkHook();
    installListeners();
    mountPanelWhenReady();
    registerMenu();
    log(`脚本已加载 v${SCRIPT_VERSION}。右侧浮窗会记录光鸭页面勾选的文件。`);
  }

  // =========================
  // 调试接口：暴露内部状态与检测函数到页面 window，方便控制台排查
  // =========================
  try {
    const debugWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    debugWindow.__gypCrossSelDebug = {
      version: SCRIPT_VERSION,
      config: CONFIG,
      state: STATE,
      ui: UI,
      collectVisibleRows,
      additiveSyncCurrentDir,
      renderPanel,
      getCurrentDirectoryDisplayName,
      batchDecompress,
      isArchiveFile,
    };
  } catch (err) {
    log('暴露调试接口失败：', err);
  }

  start();
})();
