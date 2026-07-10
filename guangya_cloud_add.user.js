// ==UserScript==
// @name         光鸭云盘 - 磁力链接云添加
// @namespace    https://www.guangyapan.com/
// @version      1.0.0
// @description  在任意网站鼠标悬停磁力链接时显示“云添加"悬浮菜单，解析磁力并一键添加到光鸭云盘云添加。
// @author       you
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @connect      api.guangyapan.com
// ==/UserScript==

(function () {
    'use strict';

    /* =========================================================================
     * 配置区
     * =========================================================================
     * 说明：
     *  1. Token 自动获取：访问光鸭云盘页面时自动嗅探登录凭证并保存；也可通过油猴菜单“设置 Token”手动输入。
     *     Token 有过期时间，可通过油猴菜单"设置 Token"随时覆盖，无需改代码。
     *  2. 默认保存目录初始为空，首次打开目录选择器时会自动查找"来自：云添加"文件夹，
     *     找到后持久化保存。保存目录也可通过弹窗内"添加到"行的目录选择器（文件树）手动选择。
     *     油猴菜单"重置保存目录"可清除已保存的目录。
     *  3. resolve_res 接口的请求体为 { url: <磁力链接> }（与 create_task 风格一致，
     *     均为 POST + JSON）。如实际接口为 GET，修改 onCloudAdd() 内的请求即可。
     *  4. 目录列表来自 get_file_list（POST），根目录 parentId 传空字符串，
     *     下级目录用文件夹的 fileId 作为 parentId 懒加载。
     * ========================================================================= */
    var API_BASE = 'https://api.guangyapan.com';
    var RESOLVE_URL = API_BASE + '/cloudcollection/v1/resolve_res';
    var CREATE_URL = API_BASE + '/cloudcollection/v1/create_task';
    var FILE_LIST_URL = API_BASE + '/userres/v1/file/get_file_list';

    var GUANGYA_LOGO = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzAiIGhlaWdodD0iMzAiIHZpZXdCb3g9IjAgMCAzMCAzMCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4NCjxnIGNsaXAtcGF0aD0idXJsKCNjbGlwMF8yOTQwXzgwODYpIj4NCjxwYXRoIGQ9Ik0wIDYuNjc5NjlDMCAyLjk5MDYgMi45OTA2IDAgNi42Nzk2OSAwSDIzLjMyMDNDMjcuMDA5NCAwIDMwIDIuOTkwNiAzMCA2LjY3OTY5VjIzLjMyMDNDMzAgMjcuMDA5NCAyNy4wMDk0IDMwIDIzLjMyMDMgMzBINi42Nzk2OUMyLjk5MDYgMzAgMCAyNy4wMDk0IDAgMjMuMzIwM1Y2LjY3OTY5WiIgZmlsbD0iI0ZGNjgwMCIvPg0KPHBhdGggZD0iTTAgNi42Nzk2OUMwIDIuOTkwNiAyLjk5MDYgMCA2LjY3OTY5IDBIMjMuMzIwM0MyNy4wMDk0IDAgMzAgMi45OTA2IDMwIDYuNjc5NjlWMjMuMzIwM0MzMCAyNy4wMDk0IDI3LjAwOTQgMzAgMjMuMzIwMyAzMEg2LjY3OTY5QzIuOTkwNiAzMCAwIDI3LjAwOTQgMCAyMy4zMjAzVjYuNjc5NjlaIiBmaWxsPSJ1cmwoI3BhaW50MF9yYWRpYWxfMjk0MF84MDg2KSIgZmlsbC1vcGFjaXR5PSIwLjciLz4NCjxwYXRoIGQ9Ik0xNi4xMDc3IDExLjY3NjdDMTYuOTU4OCAxMS42NzY3IDE3LjY0ODcgMTIuMzY0NiAxNy42NDg3IDEzLjIxMzJDMTcuNjQ4NyAxNC4wNjE4IDE2Ljk1ODggMTQuNzQ5NyAxNi4xMDc3IDE0Ljc0OTdDMTUuMjU2NyAxNC43NDk3IDE0LjU2NjcgMTQuMDYxOCAxNC41NjY3IDEzLjIxMzJDMTQuNTY2NyAxMi4zNjQ2IDE1LjI1NjcgMTEuNjc2NyAxNi4xMDc3IDExLjY3NjdaIiBmaWxsPSJ3aGl0ZSIvPg0KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0xNS43MDk4IDYuMjA5OTZDMTkuNDUwNiA2LjIwOTk2IDIyLjY0OCA4LjUyOTQyIDIzLjkzNDQgMTEuODA0NkMyMy45ODA3IDExLjkyMjMgMjQuMDkzNSAxMi4wMDE4IDI0LjIyMDMgMTIuMDAxOEgyNi44MzM2QzI2Ljk0OTIgMTIuMDAxOCAyNy4wNDI5IDEyLjA5NTIgMjcuMDQyOSAxMi4yMTA0QzI3LjA0MjkgMTIuNDI1IDI3LjAxOTcgMTIuNTI1OCAyNi45NzU3IDEyLjcyNzJDMjYuOTczMSAxMi43MzkgMjYuOTcwNSAxMi43NTA5IDI2Ljk2NzcgMTIuNzYyN0MyNi45NjUgMTIuNzc0NSAyNi45NjIyIDEyLjc4NjIgMjYuOTU5MyAxMi43OThDMjYuOTUzNiAxMi44MjE0IDI2Ljk0NzYgMTIuODQ0OCAyNi45NDEyIDEyLjg2ODFDMjYuOTM0OSAxMi44OTEzIDI2LjkyODQgMTIuOTE0NSAyNi45MjE1IDEyLjkzNzVDMjYuOTA0MyAxMi45OTUgMjYuODg1NCAxMy4wNTE4IDI2Ljg2NDggMTMuMTA3OEMyNi44NjA3IDEzLjExOSAyNi44NTY2IDEzLjEzMDIgMjYuODUyMyAxMy4xNDEzQzI2Ljc5NzEgMTMuMjg2MSAyNi43MzA3IDEzLjQyNTQgMjYuNjU0MSAxMy41NTgxQzI2LjY0ODMgMTMuNTY4MyAyNi42NDIzIDEzLjU3ODUgMjYuNjM2MyAxMy41ODg2QzI2LjYxODMgMTMuNjE5IDI2LjU5OTggMTMuNjQ5IDI2LjU4MDcgMTMuNjc4N0MyNi41NjE2IDEzLjcwODQgMjYuNTQyIDEzLjczNzcgMjYuNTIxOSAxMy43NjY2QzI2LjUwMDMgMTMuNzk3NiAyNi40NzgxIDEzLjgyODEgMjYuNDU1NCAxMy44NTgyQzI2LjQzMTkgMTMuODg5NSAyNi40MDc3IDEzLjkyMDIgMjYuMzgyOSAxMy45NTA1QzI2LjM3NDEgMTMuOTYxMiAyNi4zNjUzIDEzLjk3MTggMjYuMzU2NCAxMy45ODI0QzI2LjMyNDIgMTQuMDIwNyAyNi4yOTEgMTQuMDU4MiAyNi4yNTY5IDE0LjA5NDdDMjYuMjI0OSAxNC4xMjkgMjYuMTkyMSAxNC4xNjI1IDI2LjE1ODUgMTQuMTk1MUMyNi4xMjk0IDE0LjIyMzUgMjYuMDk5NiAxNC4yNTEzIDI2LjA2OTMgMTQuMjc4NEMyNi4wMzM3IDE0LjMxMDMgMjUuOTk3MyAxNC4zNDEzIDI1Ljk2MDIgMTQuMzcxNUMyNS45MTU5IDE0LjQwNzUgMjUuODcwNSAxNC40NDIyIDI1LjgyNCAxNC40NzU2QzI1LjY4NSAxNC41NzU2IDI1LjUzNjggMTQuNjYzOSAyNS4zODEgMTQuNzM4OEMyNS4zNzAzIDE0Ljc0MzkgMjUuMzU5NiAxNC43NDkgMjUuMzQ4OCAxNC43NTRDMjUuMjc2NCAxNC43ODc3IDI1LjIwMjQgMTQuODE4NSAyNS4xMjY5IDE0Ljg0NjNDMjUuMDY1MiAxNC44NjkxIDI1LjAwMjYgMTQuODg5OCAyNC45MzkxIDE0LjkwODVDMjQuODk1NSAxNC45MjEzIDI0Ljg1MTUgMTQuOTMzMiAyNC44MDcgMTQuOTQ0QzI0Ljc1OTkgMTQuOTU1NCAyNC43MTI0IDE0Ljk2NTggMjQuNjY0NCAxNC45NzQ5QzI0LjYyMzEgMTQuOTgyOCAyNC41ODEzIDE0Ljk4OTggMjQuNTM5NCAxNC45OTZDMjQuNDgxOCAxNS4wMDQ0IDI0LjE5NTggMTUuMDEzNyAyNC4xMDc4IDE1LjAxMzdIMjEuMTc4M0wyMS4xNzg0IDE1LjAxNDVIMjEuNjMxOUMyMS4yMjk2IDE1LjAzMyAyMS4xNzQ3IDE1LjM3NzYgMjEuMTU1NiAxNS41NTM0TDIxLjE1NTUgMTUuNTUyMkMyMC44NzY0IDIwLjE2MzUgMTcuMDM3MyAyMy44MTc0IDEyLjM0MjIgMjMuODE3NEM3LjU2Njk0IDIzLjgxNzQgMy42NzcwMSAyMC4wMzc3IDMuNTE3NjUgMTUuMzE1MUMzLjUxMjA1IDE1LjE0OSAzLjY0NzY0IDE1LjAxMzcgMy44MTQyNCAxNS4wMTM3SDYuNDA3MjRDNi42OTg5OCAxNC45OTE5IDYuODUzMzggMTQuODc0MiA2Ljg5NzYgMTQuNDMyNlYxNC40NTcyQzcuMTg1NTcgOS44NTQzIDExLjAyMDggNi4yMDk5OCAxNS43MDk4IDYuMjA5OTZaTTE1LjcwOTggOS41NzkzMkMxMi44MDA5IDkuNTc5MzQgMTAuNDI0MyAxMS44NTE0IDEwLjI2NzcgMTQuNzEyOEMxMC4yNTg2IDE0Ljg3ODcgMTAuMTI0NCAxNS4wMTM3IDkuOTU3ODYgMTUuMDEzN0g3LjIwOTIzQzYuOTY4NzYgMTUuMDMxMSA2LjkxMTY3IDE1LjIxNjEgNi45MDE5MSAxNS4zNDY2QzcuMDc0NDUgMTguMTkyOSA5LjQ0NDE5IDIwLjQ0OCAxMi4zNDIyIDIwLjQ0OEMxNS4yNTExIDIwLjQ0OCAxNy42Mjc3IDE4LjE3NTkgMTcuNzg0MyAxNS4zMTQ1QzE3Ljc5MzQgMTUuMTQ4NiAxNy45Mjc2IDE1LjAxMzcgMTguMDk0MiAxNS4wMTM3SDIwLjc2ODhDMjEuMDY2OCAxNC45NTg1IDIxLjE0MTIgMTQuNzAyNiAyMS4xMzk0IDE0LjUzNThDMjAuODk2NyAxMS43NTgzIDE4LjU1ODUgOS41NzkzMyAxNS43MDk4IDkuNTc5MzJaIiBmaWxsPSJ3aGl0ZSIvPg0KPC9nPg0KPGRlZnM+DQo8cmFkaWFsR3JhZGllbnQgaWQ9InBhaW50MF9yYWRpYWxfMjk0MF84MDg2IiBjeD0iMCIgY3k9IjAiIHI9IjEiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIiBncmFkaWVudFRyYW5zZm9ybT0idHJhbnNsYXRlKDI1LjE2NiAwLjU1NjY0KSByb3RhdGUoMTI3LjMxMikgc2NhbGUoMjIuNzY0MykiPg0KPHN0b3Agc3RvcC1jb2xvcj0iI0ZGQzMwRSIvPg0KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjRkZBNzBFIiBzdG9wLW9wYWNpdHk9IjAiLz4NCjwvcmFkaWFsR3JhZGllbnQ+DQo8Y2xpcFBhdGggaWQ9ImNsaXAwXzI5NDBfODA4NiI+DQo8cmVjdCB3aWR0aD0iMzAiIGhlaWdodD0iMzAiIGZpbGw9IndoaXRlIi8+DQo8L2NsaXBQYXRoPg0KPC9kZWZzPg0KPC9zdmc+DQo='
    // 默认保存目录：初始为空，首次加载目录时会查找"来自：云添加"文件夹并持久化
    var DEFAULT_FOLDER = null;

    // 自动获取光鸭 Token：与 guangya_quickly 共享存储键，任一脚本在光鸭页面嗅探到 Authorization 都会持久化供复用
    var GUANGYA_AUTH_STORAGE_KEY = '__GUANGYA_CLOUD_QUICKLY_AUTH__';
    var CAPTURE_EVENT = '__GYP_CLOUD_ADD_CAPTURE__';

    function getToken() {
        // 1. 油猴菜单手动覆盖
        var manual = GM_getValue('gyp_token', '');
        if (manual && manual.trim()) return normalizeAuth(manual);
        // 2. 自动嗅探/存储（与 guangya_quickly 共享）
        var stored = getStoredAuth();
        if (stored) return stored;
        // 3. 无可用 Token
        return '';
    }
    function getSelectedFolder() {
        var saved = GM_getValue('gyp_selected_folder', null);
        if (saved && saved.id != null && saved.name) return saved;
        // 如果没有保存的目录，返回根目录（id 为空字符串）
        return { id: '', name: '云盘根目录', path: [] };
    }
    function setSelectedFolder(f) {
        GM_setValue('gyp_selected_folder', { id: f.id, name: f.name, path: f.path || [] });
    }

    GM_registerMenuCommand('☁ 设置 Authorization Token', function () {
        var v = prompt('请输入 Authorization 的值（含 “Bearer “ 前缀）：', getToken());
        if (v != null) { GM_setValue('gyp_token', v.trim()); alert('Token 已保存'); }
    });
    GM_registerMenuCommand('🧽 清空手动设置的 Token', function () {
        GM_setValue('gyp_token', '');
        alert('已清空手动设置的 Token');
    });
    GM_registerMenuCommand('🧹 清除自动获取的 Token', function () {
        try { GM_setValue(GUANGYA_AUTH_STORAGE_KEY, ''); } catch (e) {}
        try { window.localStorage.removeItem(GUANGYA_AUTH_STORAGE_KEY); } catch (e) {}
        alert('已清除自动获取的 Token，下次访问光鸭云盘时会重新嗅探');
    });
    GM_registerMenuCommand('🔄 重置保存目录', function () {
        GM_deleteValue('gyp_selected_folder');
        alert('已重置保存目录，下次打开目录选择器时会自动查找"来自：云添加"文件夹');
    });

    /* =========================================================================
     * 工具函数
     * ========================================================================= */
    function formatSize(bytes) {
        if (bytes == null || isNaN(bytes)) return '-';
        bytes = Number(bytes);
        if (bytes < 1024) return bytes + ' B';
        var units = ['KB', 'MB', 'GB', 'TB', 'PB'];
        var i = -1;
        do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
        return bytes.toFixed(2) + ' ' + units[i];
    }
    function formatTime(ts) {
        if (!ts) return '-';
        try { return new Date(ts * 1000).toLocaleString(); } catch (e) { return String(ts); }
    }
    function resTypeName(t) {
        var map = { 1: 'BT 种子', 2: 'HTTP/直链', 3: 'ed2k' };
        return map[t] || ('类型 ' + (t != null ? t : '?'));
    }
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // 统一的 GM 请求，返回 { status, json, text }
    function gmRequest(method, url, bodyObj) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: method,
                url: url,
                timeout: 30000,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': getToken()
                },
                data: bodyObj ? JSON.stringify(bodyObj) : undefined,
                onload: function (r) {
                    var json = null;
                    try { json = JSON.parse(r.responseText); } catch (e) {}
                    resolve({ status: r.status, json: json, text: r.responseText });
                },
                onerror: function () { reject(new Error('网络请求失败，请检查网络')); },
                ontimeout: function () { reject(new Error('请求超时')); }
            });
        });
    }

    // 解析接口返回是否成功（兼容 msg=success / code=0 / HTTP 2xx）
    function parseApiResult(r) {
        var ok = r.status >= 200 && r.status < 300;
        var msg = '';
        if (r.json) {
            if (r.json.msg != null && r.json.msg !== 'success') { ok = false; msg = r.json.msg; }
            if (r.json.code != null && r.json.code !== 0) { ok = false; msg = msg || ('code=' + r.json.code); }
        }
        if (!ok && !msg) msg = r.text ? r.text.slice(0, 200) : ('HTTP ' + r.status);
        if (r.status === 401) msg = (msg ? msg + '；' : '') + 'Token 可能已过期，请通过油猴菜单更新';
        return { ok: ok, msg: msg, json: r.json };
    }

    /* =========================================================================
     * 自动获取光鸭 Token（注入页面 hook，嗅探光鸭请求的 Authorization 头）
     * ========================================================================= */
    // 统一为 "Bearer xxx" 形式
    function normalizeAuth(value) {
        var text = String(value == null ? '' : value).trim();
        if (!text) return '';
        return /^Bearer\s+/i.test(text) ? text : ('Bearer ' + text);
    }

    function isGuangyaPageHost() {
        return /(^|\.)guangyapan\.com$/i.test(window.location.hostname || '');
    }

    // 读取已存储的 Authorization：优先 GM（跨域持久），其次 localStorage
    function getStoredAuth() {
        try {
            if (typeof GM_getValue === 'function') {
                var v = GM_getValue(GUANGYA_AUTH_STORAGE_KEY, '');
                if (typeof v === 'string' && v.trim()) return normalizeAuth(v);
            }
        } catch (e) {}
        try {
            return normalizeAuth(window.localStorage.getItem(GUANGYA_AUTH_STORAGE_KEY) || '');
        } catch (e) {
            return '';
        }
    }

    function setStoredAuth(value) {
        var auth = normalizeAuth(value);
        if (!auth) return;
        try {
            if (typeof GM_setValue === 'function') GM_setValue(GUANGYA_AUTH_STORAGE_KEY, auth);
        } catch (e) {}
        try {
            window.localStorage.setItem(GUANGYA_AUTH_STORAGE_KEY, auth);
        } catch (e) {}
    }

    // 仅在光鸭页面落盘，避免在其它站点误存
    function rememberAuth(auth) {
        if (!isGuangyaPageHost() || !auth) return;
        setStoredAuth(auth);
    }

    // 注入到页面上下文的 hook 源码：patch fetch/XHR，捕获光鸭请求的 Authorization
    function networkHookPayload(EVENT_NAME) {
        if (window.__gypCloudAddHookInstalled) return;
        window.__gypCloudAddHookInstalled = true;
        function shouldCapture(url) {
            if (typeof url !== 'string' || !url) return false;
            try {
                var host = new URL(url, location.href).hostname.toLowerCase();
                return host === 'guangyapan.com' || host.endsWith('.guangyapan.com');
            } catch (e) {
                return String(url).indexOf('guangyapan.com') !== -1;
            }
        }
        function emit(auth) {
            try { window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { authorization: auth } })); } catch (e) {}
        }
        function readAuth(hs) {
            if (!hs) return '';
            if (typeof Headers !== 'undefined' && hs instanceof Headers) return hs.get('authorization') || '';
            if (Array.isArray(hs)) {
                for (var i = 0; i < hs.length; i++) {
                    if (String(hs[i][0]).toLowerCase() === 'authorization') return hs[i][1];
                }
                return '';
            }
            if (typeof hs === 'object') {
                for (var k in hs) {
                    if (Object.prototype.hasOwnProperty.call(hs, k) && String(k).toLowerCase() === 'authorization') return hs[k];
                }
            }
            return '';
        }
        var origFetch = window.fetch;
        if (typeof origFetch === 'function') {
            window.fetch = function (input, init) {
                try {
                    var url = typeof input === 'string' ? input : (input && input.url) || '';
                    if (shouldCapture(url)) {
                        var auth = readAuth((init && init.headers) || (input && input.headers));
                        if (auth) emit(auth);
                    }
                } catch (e) {}
                return origFetch.apply(this, arguments);
            };
        }
        var origOpen = XMLHttpRequest.prototype.open;
        var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
            this.__gypCa = { url: url, headers: {} };
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            if (this.__gypCa) this.__gypCa.headers[String(name).toLowerCase()] = value;
            return origSetHeader.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
            try {
                if (this.__gypCa && shouldCapture(this.__gypCa.url) && this.__gypCa.headers.authorization) {
                    emit(this.__gypCa.headers.authorization);
                }
            } catch (e) {}
            return origSend.apply(this, arguments);
        };
    }

    // 把 hook 注入页面上下文（跨油猴沙盒），失败（如 CSP）则静默回退到已存储/内置 token
    function injectNetworkHook() {
        try {
            var code = '(' + networkHookPayload.toString() + ')(' + JSON.stringify(CAPTURE_EVENT) + ');';
            var s = document.createElement('script');
            s.textContent = code;
            (document.documentElement || document.head || document.body).appendChild(s);
            s.remove();
        } catch (e) { /* ignore */ }
    }

    // 从 <a> 中提取磁力链接
    function getMagnetFromAnchor(a) {
        if (!a) return null;
        var href = a.getAttribute && a.getAttribute('href');
        if (href && /^magnet:/i.test(href)) return href.trim();
        var text = (a.textContent || '').trim();
        if (/^magnet:/i.test(text)) return text;
        if (href) {
            var m = href.match(/(magnet:\?xt=urn:btih:[A-Za-z0-9]+)/);
            if (m) return m[1];
        }
        return null;
    }

    /* =========================================================================
     * 样式注入
     * ========================================================================= */
    var STYLE_ID = 'gyp-cloud-add-style';
    if (!document.getElementById(STYLE_ID)) {
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
            '#gyp-hover-group{position:fixed;z-index:2147483647;display:none;align-items:center;gap:6px;',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;}',
            '#gyp-hover-btn,#gyp-hover-copy{display:inline-flex;align-items:center;gap:4px;',
            'padding:5px 11px;font-size:12px;line-height:1;color:#ff6800;',
            'background:#fff;border:1px solid #ff6800;border-radius:14px;',
            'box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer;',
            'white-space:nowrap;user-select:none;}',
            '#gyp-hover-btn .gyp-logo-icon{width:16px;height:16px;vertical-align:middle;}',
            '#gyp-hover-copy .gyp-copy-icon{font-size:14px;line-height:1;}',
            '#gyp-hover-btn:hover,#gyp-hover-copy:hover{background:#fff3e6;transform:translateY(-1px);}',
            '#gyp-hover-copy.copied{color:#16a34a;border-color:#16a34a;background:#fff;}',
            '#gyp-overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);',
            'display:flex;align-items:center;justify-content:center;',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;}',
            '#gyp-modal{width:540px;max-width:92vw;max-height:86vh;display:flex;flex-direction:column;',
            'background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden;color:#1f2937;}',
            '#gyp-modal .gyp-header{display:flex;align-items:center;justify-content:space-between;',
            'padding:14px 18px;background:linear-gradient(135deg,#ff8a33,#ff6800);color:#fff;font-size:15px;font-weight:600;}',
            '#gyp-modal .gyp-header-icon{width:18px;height:18px;vertical-align:middle;margin-right:6px;}',
            '#gyp-modal .gyp-close{background:none;border:none;color:#fff;font-size:24px;cursor:pointer;line-height:1;padding:0 4px;}',
            '#gyp-modal .gyp-body{padding:16px 18px;overflow-y:auto;font-size:13px;}',
            '#gyp-modal .gyp-row{display:block;margin-bottom:12px;width:100%;box-sizing:border-box;clear:both;}',
            '#gyp-modal .gyp-label{display:inline-block;vertical-align:top;width:80px;color:#6b7280;}',
            '#gyp-modal .gyp-value{display:inline-block;vertical-align:top;width:calc(100% - 85px);word-break:break-all;box-sizing:border-box;}',
            '#gyp-modal input.gyp-input{width:100%;padding:6px 9px;border:1px solid #d1d5db;border-radius:6px;',
            'font-size:13px;box-sizing:border-box;font-family:inherit;}',
            '#gyp-modal input.gyp-input:focus{outline:none;border-color:#ff6800;box-shadow:0 0 0 2px rgba(255,104,0,.15);}',
            '#gyp-modal .gyp-subhead{margin:14px 0 8px;padding-top:12px;border-top:1px solid #f0f0f0;',
            'display:flex;align-items:center;justify-content:space-between;font-weight:600;}',
            '#gyp-modal .gyp-toggle{color:#ff6800;cursor:pointer;font-weight:400;font-size:12px;}',
            '#gyp-modal .gyp-multi-info{display:flex;gap:16px;flex-wrap:wrap;}',
            '#gyp-modal .gyp-info-item{display:flex;flex-direction:row;gap:2px;}',
            '#gyp-modal .gyp-info-label{font-size:12px;color:#6b7280;}',
            '#gyp-modal .gyp-info-value{font-size:13px;color:#1f2937;}',
            '#gyp-modal .gyp-sublist{list-style:none;margin:0;padding:0;max-height:400px;overflow-y:auto;',
            'border:1px solid #eee;border-radius:8px;}',
            '#gyp-modal .gyp-subitem{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #f5f5f5;}',
            '#gyp-modal .gyp-subitem:last-child{border-bottom:none;}',
            '#gyp-modal .gyp-subitem:hover{background:#f9fafb;}',
            '#gyp-modal .gyp-subtoggle{width:16px;text-align:center;color:#b1b1b1;cursor:pointer;flex-shrink:0;user-select:none;font-size:12px;}',
            '#gyp-modal .gyp-subtoggle:hover{color:#ff6800;}',
            /* 自定义复选框 */
            '#gyp-modal .gyp-check{position:absolute;opacity:0;width:0;height:0;}',
            '#gyp-modal .gyp-custom-checkbox{width:16px;height:16px;border:2px solid #d1d5db;border-radius:4px;flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.2s;box-sizing:border-box;}',
            '#gyp-modal .gyp-custom-checkbox:hover{border-color:#ff6800;}',
            '#gyp-modal .gyp-check:checked + .gyp-custom-checkbox{background:#ff6800;border-color:#ff6800;}',
            '#gyp-modal .gyp-check:checked + .gyp-custom-checkbox::after{content:"";width:8px;height:4px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(-45deg);margin-top:-1px;}',
            '#gyp-modal .gyp-check:indeterminate + .gyp-custom-checkbox{background:#fff;border-color:#ff6800;}',
            '#gyp-modal .gyp-check:indeterminate + .gyp-custom-checkbox::after{content:"";width:8px;height:2px;background:#ff6800;}',
            '#gyp-modal .gyp-subicon{font-size:14px;flex-shrink:0;}',
            '#gyp-modal .gyp-subname{flex:1;word-break:break-all;min-width:0;}',
            '#gyp-modal .gyp-subsize{color:#9ca3af;font-size:12px;flex-shrink:0;}',
            '#gyp-modal .gyp-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;',
            'padding:12px 18px;border-top:1px solid #eee;background:#fafafa;}',
            '#gyp-modal .gyp-status{flex:1;font-size:12px;color:#6b7280;word-break:break-all;}',
            '#gyp-modal .gyp-status.err{color:#dc2626;}',
            '#gyp-modal .gyp-status.ok{color:#16a34a;}',
            '#gyp-modal button.gyp-btn{padding:7px 16px;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-weight:500;font-family:inherit;}',
            '#gyp-modal .gyp-btn-primary{background:#ff6800;color:#fff;}',
            '#gyp-modal .gyp-btn-primary:hover{background:#e65c00;}',
            '#gyp-modal .gyp-btn-primary:disabled{background:#ffc299;cursor:not-allowed;}',
            '#gyp-modal .gyp-btn-ghost{background:#e5e7eb;color:#374151;}',
            '#gyp-modal .gyp-btn-ghost:hover{background:#d1d5db;}',
            '#gyp-modal .gyp-loading{text-align:center;padding:50px 0;color:#6b7280;}',
            '#gyp-modal .gyp-spinner{display:inline-block;width:28px;height:28px;border:3px solid #e5e7eb;',
            'border-top-color:#ff6800;border-radius:50%;animation:gypspin .8s linear infinite;margin-bottom:12px;}',
            '#gyp-modal .gyp-error{padding:30px 10px;color:#dc2626;text-align:center;line-height:1.7;word-break:break-all;}',
            '@keyframes gypspin{to{transform:rotate(360deg);}}',
            /* “添加到"目录选择行 */
            '#gyp-modal .gyp-folder-pick{display:flex;align-items:center;gap:6px;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;background:#f9fafb;font-size:13px;width:100%;box-sizing:border-box;}',
            '#gyp-modal .gyp-folder-pick:hover{border-color:#ff6800;background:#fff3e6;}',
            '#gyp-modal .gyp-fp-icon{font-size:15px;flex-shrink:0;}',
            '#gyp-modal .gyp-fp-name{font-weight:600;color:#1f2937;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;}',
            '#gyp-modal .gyp-fp-path{flex:1;color:#9ca3af;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}',
            '#gyp-modal .gyp-fp-arrow{color:#ff6800;font-size:12px;flex-shrink:0;}',
            /* 目录选择器弹窗（叠加在结果弹窗之上） */
            '#gyp-folder-picker{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}',
            '#gyp-folder-picker #gyp-modal.gyp-folder-modal{width:480px;height:560px;}',
            '#gyp-folder-picker .gyp-folder-path{padding:8px 18px;background:#fff3e6;font-size:12px;color:#6b7280;border-bottom:1px solid #eee;word-break:break-all;}',
            '#gyp-folder-picker .gyp-tree{flex:1;overflow-y:auto;padding:6px 8px;}',
            '#gyp-folder-picker .gyp-fnode{list-style:none;}',
            '#gyp-folder-picker .gyp-frow{display:flex;align-items:center;gap:6px;padding:6px 6px;border-radius:6px;cursor:pointer;font-size:13px;}',
            '#gyp-folder-picker .gyp-frow:hover{background:#fff3e6;}',
            '#gyp-folder-picker .gyp-fnode.sel > .gyp-frow{background:#ffe6cc;}',
            '#gyp-folder-picker .gyp-fnode.sel > .gyp-frow .gyp-fname{color:#e65c00;font-weight:600;}',
            '#gyp-folder-picker .gyp-toggle{width:14px;text-align:center;color:#b1b1b1;cursor:pointer;flex-shrink:0;user-select:none;}',
            '#gyp-folder-picker .gyp-toggle:hover{color:#ff6800;}',
            '#gyp-folder-picker .gyp-radio{width:14px;height:14px;border:2px solid #d1d5db;border-radius:50%;flex-shrink:0;box-sizing:border-box;}',
            '#gyp-folder-picker .gyp-fnode.sel > .gyp-frow .gyp-radio{border-color:#ff6800;background:#ff6800;box-shadow:inset 0 0 0 2px #fff;}',
            '#gyp-folder-picker .gyp-ficon{font-size:14px;flex-shrink:0;}',
            '#gyp-folder-picker .gyp-fname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}',
            '#gyp-folder-picker .gyp-fcount{color:#9ca3af;font-size:11px;flex-shrink:0;}',
            '#gyp-folder-picker .gyp-children{margin:0;padding:0;}',
            '#gyp-folder-picker .gyp-loading-row{list-style:none;padding:6px 10px;color:#9ca3af;font-size:12px;}'
        ].join('');
        (document.head || document.documentElement).appendChild(style);
    }

    /* =========================================================================
     * 自动获取光鸭 Token：监听页面 hook 抛出的 Authorization 并落盘
     * ========================================================================= */
    window.addEventListener(CAPTURE_EVENT, function (event) {
        var detail = event && event.detail ? event.detail : {};
        if (detail.authorization) rememberAuth(detail.authorization);
    });
    // 仅在光鸭页面注入 hook 嗅探；其它站点只读取已存储的 token
    if (isGuangyaPageHost()) {
        injectNetworkHook();
    }

    /* =========================================================================
     * 悬浮“云添加"按钮
     * ========================================================================= */
    var btnGroup = document.createElement('div');
    btnGroup.id = 'gyp-hover-group';

    var btn = document.createElement('div');
    btn.id = 'gyp-hover-btn';
    btn.innerHTML = '<img src="' + GUANGYA_LOGO + '" class="gyp-logo-icon">';
    btn.title = '点击解析磁力并添加到光鸭云盘';

    var COPY_BTN_HTML = '<span class="gyp-copy-icon">🧲</span>';
    var copyBtn = document.createElement('div');
    copyBtn.id = 'gyp-hover-copy';
    copyBtn.innerHTML = COPY_BTN_HTML;
    copyBtn.title = '复制磁力链接';

    btnGroup.appendChild(btn);
    btnGroup.appendChild(copyBtn);
    document.documentElement.appendChild(btnGroup);

    var currentMagnet = null;
    var hideTimer = null;
    var BTN_H = 26;

    function positionBtn(link) {
        var rect = link.getBoundingClientRect();
        var top = rect.top - BTN_H - 6;
        if (top < 4) top = rect.bottom + 6; // 上方放不下则放到下方
        btnGroup.style.top = top + 'px';
        btnGroup.style.display = 'inline-flex';
        var groupWidth = btnGroup.offsetWidth || 120;
        btnGroup.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - groupWidth - 8)) + 'px';
    }
    function hideBtn() { btnGroup.style.display = 'none'; currentMagnet = null; }
    function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hideBtn, 250); }

    // 复制磁力链接到剪贴板，并在按钮上短暂反馈
    function copyMagnet(magnet) {
        var ok = false;
        if (typeof GM_setClipboard === 'function') {
            try { GM_setClipboard(magnet); ok = true; } catch (e) { ok = false; }
        }
        if (!ok) {
            var ta = document.createElement('textarea');
            ta.value = magnet;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.top = '0';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); ok = true; } catch (e) { ok = false; }
            document.body.removeChild(ta);
        }
        if (!ok) return;
        copyBtn.innerHTML = '<span class="gyp-copy-icon">✓</span> 已复制';
        copyBtn.classList.add('copied');
        setTimeout(function () {
            copyBtn.innerHTML = COPY_BTN_HTML;
            copyBtn.classList.remove('copied');
        }, 1200);
    }

    document.addEventListener('mouseover', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (a) {
            var m = getMagnetFromAnchor(a);
            if (m) {
                clearTimeout(hideTimer);
                currentMagnet = m;
                positionBtn(a);
                return;
            }
        }
        if (!(e.target === btnGroup || btnGroup.contains(e.target))) scheduleHide();
    }, true);

    document.addEventListener('mouseout', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (a && getMagnetFromAnchor(a)) {
            if (!(e.relatedTarget && (e.relatedTarget === btnGroup || btnGroup.contains(e.relatedTarget)))) {
                scheduleHide();
            }
        }
    }, true);

    btnGroup.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    btnGroup.addEventListener('mouseleave', scheduleHide);
    btn.addEventListener('click', function () {
        if (!currentMagnet) return;
        var magnet = currentMagnet;
        hideBtn();
        onCloudAdd(magnet);
    });
    copyBtn.addEventListener('click', function () {
        if (!currentMagnet) return;
        copyMagnet(currentMagnet);
    });

    window.addEventListener('scroll', scheduleHide, true);

    /* =========================================================================
     * 目录选择器（文件树，懒加载下级）
     * ========================================================================= */
    function fetchFileList(parentId) {
        return gmRequest('POST', FILE_LIST_URL, {
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

    function updateFolderPickRow(body, folder) {
        var pick = body.querySelector('.gyp-folder-pick');
        if (!pick) return;
        pick.querySelector('.gyp-fp-name').textContent = folder.name || '';
        var pathStr = folder.path && folder.path.length ? folder.path.join(' / ') : '';
        pick.querySelector('.gyp-fp-path').textContent = pathStr;
    }

    function closeFolderPicker() {
        var p = document.getElementById('gyp-folder-picker');
        if (p) p.remove();
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
            '  <div class="gyp-footer">' +
            '    <span class="gyp-status"></span>' +
            '    <button class="gyp-btn gyp-btn-ghost gyp-cancel">取消</button>' +
            '    <button class="gyp-btn gyp-btn-primary gyp-confirm" disabled>选择此目录</button>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(overlay);

        var tree = overlay.querySelector('.gyp-tree');
        var pathEl = overlay.querySelector('.gyp-folder-path');
        var confirmBtn = overlay.querySelector('.gyp-confirm');
        var statusEl = overlay.querySelector('.gyp-status');
        var picked = null;

        overlay.querySelector('.gyp-close').addEventListener('click', closeFolderPicker);
        overlay.querySelector('.gyp-cancel').addEventListener('click', closeFolderPicker);
        overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeFolderPicker(); });
        confirmBtn.addEventListener('click', function () {
            if (picked) onConfirm(picked);
            closeFolderPicker();
        });

        function getPathOfNode(li) {
            if (li.dataset.id === '') return []; // 根目录
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
            statusEl.className = 'gyp-status';
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
                    if (!toggle.textContent.trim()) return; // 叶子节点
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
                if (folders.length === 0) { toggle.textContent = ''; return; } // 实际无子目录
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
            // 查找”来自：云添加”文件夹
            var targetFolder = null;
            var targetNode = null;
            Array.prototype.some.call(tree.querySelectorAll('.gyp-fnode'), function (n) {
                if (n.dataset.name === '来自：云添加') {
                    targetNode = n;
                    targetFolder = {
                        id: n.dataset.id,
                        name: n.dataset.name,
                        path: [n.dataset.name]
                    };
                    return true;
                }
                return false;
            });
            // 如果找到且还没有保存的目录，则持久化保存
            if (targetFolder && !GM_getValue('gyp_selected_folder', null)) {
                setSelectedFolder(targetFolder);
            }
            // 默认选中逻辑：
            // 1. 如果已保存的目录在一级目录中（depth === 0），则选中它
            // 2. 否则，不默认选中任何文件夹
            var saved = getSelectedFolder();
            var nodeToSelect = null;
            var allNodes = tree.querySelectorAll('.gyp-fnode');
            if (saved && saved.id !== '') {
                // 尝试在树中找到已保存的目录节点
                Array.prototype.some.call(allNodes, function (n) {
                    if (n.dataset.id === saved.id) {
                        // 仅当节点在一级目录（depth === 0）时才选中它
                        if (parseInt(n.dataset.depth, 10) === 0) {
                            nodeToSelect = n;
                        }
                        return true;
                    }
                    return false;
                });
            }
            // 只有找到合适的节点才选中，否则不选中任何文件夹
            if (nodeToSelect) {
                selectNode(nodeToSelect);
            }
        }).catch(function (e) {
            tree.innerHTML = '<div class="gyp-error">❌ 目录加载失败：' + escapeHtml(e.message) + '</div>';
            statusEl.textContent = '加载失败，请检查 Token';
            statusEl.className = 'gyp-status err';
        });
    }

    /* =========================================================================
     * 弹窗（解析结果 / 创建任务）
     * ========================================================================= */
    function escClose(e) {
        if (e.key !== 'Escape') return;
        if (document.getElementById('gyp-folder-picker')) closeFolderPicker();
        else closeOverlay();
    }
    function closeOverlay() {
        var ov = document.getElementById('gyp-overlay');
        if (ov) ov.remove();
        document.removeEventListener('keydown', escClose);
    }

    function buildModal() {
        var overlay = document.createElement('div');
        overlay.id = 'gyp-overlay';
        overlay.innerHTML =
            '<div id="gyp-modal" role="dialog" aria-modal="true">' +
            '  <div class="gyp-header"><span><img src="' + GUANGYA_LOGO + '" class="gyp-header-icon"> 光鸭云盘 · 云添加</span><button class="gyp-close" title="关闭">×</button></div>' +
            '  <div class="gyp-body"></div>' +
            '  <div class="gyp-footer">' +
            '    <span class="gyp-status"></span>' +
            '    <button class="gyp-btn gyp-btn-primary gyp-add" style="display:none;">立即添加</button>' +
            '    <button class="gyp-btn gyp-btn-ghost gyp-cancel">取消</button>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(overlay);
        overlay.querySelector('.gyp-close').addEventListener('click', closeOverlay);
        overlay.querySelector('.gyp-cancel').addEventListener('click', closeOverlay);
        overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeOverlay(); });
        document.addEventListener('keydown', escClose);
        return overlay;
    }

    function setStatus(el, text, cls) {
        el.textContent = text;
        el.className = 'gyp-status' + (cls ? ' ' + cls : '');
    }
    function showErrorBody(body, status, msg) {
        body.innerHTML = '<div class="gyp-error">❌ ' + escapeHtml(msg) + '</div>';
        setStatus(status, '操作失败', 'err');
    }

    // 弹窗提示用户补充 Token：前往光鸭云盘自动获取 或 手动输入
    function promptAndSaveToken() {
        var v = prompt('请输入光鸭云盘的 Authorization（形如 "Bearer eyJ..."）：', getToken());
        if (v == null) return false;
        var trimmed = v.trim();
        if (trimmed) {
            GM_setValue('gyp_token', trimmed);
            return true;
        }
        return false;
    }

    function openGuangyaPage() {
        var url = 'https://www.guangyapan.com/';
        try {
            if (typeof GM_openInTab === 'function') {
                GM_openInTab(url, { active: true });
                return;
            }
        } catch (e) {}
        window.open(url, '_blank');
    }

    function renderTokenMissing(overlay, magnet) {
        var body = overlay.querySelector('.gyp-body');
        var status = overlay.querySelector('.gyp-status');
        setStatus(status, '未获取到登录凭证', 'err');
        body.innerHTML =
            '<div class="gyp-error">⚠️ 未获取到光鸭云盘的登录凭证（Token）</div>' +
            '<div style="margin-top:10px;line-height:1.7;color:#6b7280;font-size:13px;">请选择获取方式：</div>' +
            '<div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;">' +
            '<button class="gyp-btn gyp-btn-primary gyp-goto">前往光鸭云盘自动获取</button>' +
            '<button class="gyp-btn gyp-btn-ghost gyp-manual">手动输入 Token</button>' +
            '</div>' +
            '<div style="margin-top:12px;color:#9ca3af;font-size:12px;line-height:1.6;">前往光鸭云盘并登录后，Token 会自动嗅探并保存；返回本页重新点击云添加即可继续。</div>';
        var gotoBtn = body.querySelector('.gyp-goto');
        var manualBtn = body.querySelector('.gyp-manual');
        if (gotoBtn) {
            gotoBtn.addEventListener('click', function () {
                openGuangyaPage();
                closeOverlay();
            });
        }
        if (manualBtn) {
            manualBtn.addEventListener('click', function () {
                if (promptAndSaveToken()) {
                    closeOverlay();
                    onCloudAdd(magnet);
                }
            });
        }
    }

    // 主流程：点击“云添加"
    function onCloudAdd(magnet) {
        if (document.getElementById('gyp-overlay')) return; // 避免重复弹窗
        var overlay = buildModal();
        var body = overlay.querySelector('.gyp-body');
        var status = overlay.querySelector('.gyp-status');
        var addBtn = overlay.querySelector('.gyp-add');

        // 无 Token：提示前往光鸭云盘自动获取或手动输入，不发起解析请求
        if (!getToken()) {
            renderTokenMissing(overlay, magnet);
            return;
        }

        body.innerHTML = '<div class="gyp-loading"><div class="gyp-spinner"></div><br>正在解析磁力链接…</div>';
        setStatus(status, '解析中…', '');

        gmRequest('POST', RESOLVE_URL, { url: magnet }).then(function (r) {
            var ret = parseApiResult(r);
            if (!ret.ok || !ret.json || !ret.json.data) {
                showErrorBody(body, status, '解析失败：' + ret.msg);
                return;
            }
            renderResult(overlay, magnet, ret.json.data);
        }).catch(function (e) {
            showErrorBody(body, status, '解析请求失败：' + e.message);
        });
    }

    // 渲染解析结果
    function renderResult(overlay, magnet, data) {
        var body = overlay.querySelector('.gyp-body');
        var status = overlay.querySelector('.gyp-status');
        var addBtn = overlay.querySelector('.gyp-add');
        addBtn.style.display = '';

        var bt = data.btResInfo || {};
        var subfiles = bt.subfiles || [];
        // 如果没有subfiles但有fileName和fileSize，则创建虚拟文件
        if (subfiles.length === 0 && bt.fileName && bt.fileSize != null) {
            subfiles = [{
                fileName: bt.fileName,
                fileSize: bt.fileSize
            }];
        }
        var newName = bt.fileName || '';
        var url = data.url || magnet;

        // 计算实际文件数量（不包括文件夹）
        function countFiles(files) {
            var count = 0;
            files.forEach(function (f) {
                if (f.isDir === true) {
                    if (f.subfiles) {
                        count += countFiles(f.subfiles);
                    }
                } else {
                    count++;
                }
            });
            return count;
        }
        var totalFileCount = countFiles(subfiles);

        body.innerHTML =
            '<div class="gyp-row"><div class="gyp-label">文件名</div><div class="gyp-value">' +
            '<input class="gyp-input gyp-newname" value="' + escapeHtml(newName) + '"></div></div>' +
            '<div class="gyp-row gyp-multi-info">' +
            '<div class="gyp-info-item"><span class="gyp-info-label">总大小</span><span class="gyp-info-value">' + escapeHtml(formatSize(bt.fileSize)) + '</span></div>' +
            '<div class="gyp-info-item"><span class="gyp-info-label">文件数</span><span class="gyp-info-value">' + escapeHtml(String(bt.subfilesNum != null ? bt.subfilesNum : totalFileCount)) + '</span></div>' +
            '<div class="gyp-info-item"><span class="gyp-info-label">创建时间</span><span class="gyp-info-value">' + escapeHtml(formatTime(bt.createTime)) + '</span></div>' +
            '</div>' +
            '<div class="gyp-row"><div class="gyp-label">添加到</div><div class="gyp-value">' +
            '<div class="gyp-folder-pick" title="点击选择保存目录">' +
            '<span class="gyp-fp-icon">📁</span>' +
            '<span class="gyp-fp-name"></span>' +
            '<span class="gyp-fp-path"></span>' +
            '<span class="gyp-fp-arrow">更改 ▾</span>' +
            '</div></div>' +
            '<div class="gyp-subhead"><span class="gyp-selected-count">已选 ' + getInitialSelectedCount() + ' 个</span><span class="gyp-toggle">全选 / 反选</span></div>' +
            '<ul class="gyp-sublist"></ul>';

        // 判断是否为符合条件的视频文件
        function isSelectableVideo(file) {
            var videoExts = ['mp4', 'mkv', 'mov', 'avi', 'flv', 'm4v', 'ts', 'wmv', 'rmvb', 'mpeg'];
            var minSize = 10 * 1024 * 1024; // 10MB
            var fileName = (file.fileName || '').toLowerCase();
            var extMatch = videoExts.some(function (ext) {
                return fileName.endsWith('.' + ext);
            });
            var sizeOk = file.fileSize != null && file.fileSize >= minSize;
            return extMatch && sizeOk;
        }

        // 扁平化存储所有文件，用于收集选中的索引
        var allFiles = [];
        var fileIndex = 0;

        // 计算初始选中的文件数量（只统计文件，不统计文件夹）
        function getInitialSelectedCount() {
            var count = 0;
            for (var i = 0; i < subfiles.length; i++) {
                var f = subfiles[i];
                if (f.isDir === true) {
                    // 递归统计文件夹下的文件
                    if (f.subFiles) {
                        count += countSelectedInFolder(f.subFiles);
                    }
                } else {
                    if (isSelectableVideo(f)) {
                        count++;
                    }
                }
            }
            return count;
        }

        // 递归统计文件夹下选中的文件数量
        function countSelectedInFolder(files) {
            var count = 0;
            for (var i = 0; i < files.length; i++) {
                var f = files[i];
                if (f.isDir === true) {
                    if (f.subFiles) {
                        count += countSelectedInFolder(f.subFiles);
                    }
                } else {
                    if (isSelectableVideo(f)) {
                        count++;
                    }
                }
            }
            return count;
        }

        // 更新已选文件数量显示
        function updateSelectedCount() {
            var checks = body.querySelectorAll('.gyp-check:checked');
            var count = 0;
            Array.prototype.forEach.call(checks, function (c) {
                var idx = Number(c.dataset.i);
                var fileInfo = allFiles[idx];
                if (fileInfo && fileInfo.file.isDir !== true) {
                    count++;
                }
            });
            var countSpan = body.querySelector('.gyp-selected-count');
            if (countSpan) {
                countSpan.textContent = '已选 ' + count + ' 个';
            }
        }

        // 递归渲染文件/文件夹
        function renderFileList(container, files, depth) {
            files.forEach(function (f) {
                var currentIndex = fileIndex++;
                allFiles.push({ file: f, index: currentIndex });

                var li = document.createElement('li');
                li.className = 'gyp-subitem';
                li.style.paddingLeft = (depth * 16 + 10) + 'px';

                var isDir = f.isDir === true;
                var checked = '';
                var sizeText = '';
                var icon = '📄';
                var toggleHtml = '';

                if (isDir) {
                    icon = '📁';
                    sizeText = '-';
                    // 文件夹不勾选
                    checked = '';
                    // 如果有子文件，添加展开按钮
                    if (f.subfiles && f.subfiles.length > 0) {
                        toggleHtml = '<span class="gyp-subtoggle" data-expanded="false">▶</span>';
                    } else {
                        toggleHtml = '<span class="gyp-subtoggle"></span>';
                    }
                } else {
                    checked = isSelectableVideo(f) ? ' checked' : '';
                    sizeText = formatSize(f.fileSize);
                    toggleHtml = '<span class="gyp-subtoggle"></span>';
                }

                li.innerHTML =
                    toggleHtml +
                    '<input type="checkbox" class="gyp-check" data-i="' + currentIndex + '"' + checked + '>' +
                    '<span class="gyp-custom-checkbox"></span>' +
                    '<span class="gyp-subicon">' + icon + '</span>' +
                    '<span class="gyp-subname" title="' + escapeHtml(f.fileName) + '">' + escapeHtml(f.fileName) + '</span>' +
                    '<span class="gyp-subsize">' + escapeHtml(sizeText) + '</span>';

                container.appendChild(li);

                // 添加自定义复选框点击事件
                var customCheckbox = li.querySelector('.gyp-custom-checkbox');
                var checkbox = li.querySelector('.gyp-check');
                if (customCheckbox && checkbox) {
                    customCheckbox.addEventListener('click', function (e) {
                        e.preventDefault();
                        checkbox.checked = !checkbox.checked;
                        checkbox.dispatchEvent(new Event('change'));
                    });
                }

                // 如果是文件，添加change事件，可能需要更新父文件夹状态
                if (!isDir) {
                    var checkbox = li.querySelector('.gyp-check');
                    if (checkbox) {
                        checkbox.addEventListener('change', function () {
                            // 更新已选数量
                            updateSelectedCount();
                            // 向上遍历，更新父文件夹状态
                            var parent = container.parentElement;
                            while (parent && parent.classList) {
                                if (parent.classList.contains('gyp-subchildren')) {
                                    var parentLi = parent.previousElementSibling;
                                    if (parentLi) {
                                        var parentCheck = parentLi.querySelector('.gyp-check');
                                        if (parentCheck) {
                                            var siblingChecks = parent.querySelectorAll('.gyp-check');
                                            var allChecked = Array.prototype.every.call(siblingChecks, function (c) { return c.checked; });
                                            var noneChecked = Array.prototype.every.call(siblingChecks, function (c) { return !c.checked; });
                                            parentCheck.checked = allChecked;
                                            parentCheck.indeterminate = !allChecked && !noneChecked;
                                        }
                                    }
                                    parent = parent.parentElement;
                                } else {
                                    break;
                                }
                            }
                        });
                    }
                }

                // 如果是文件夹且有子文件，添加子容器
                if (isDir && f.subfiles && f.subfiles.length > 0) {
                    var childContainer = document.createElement('ul');
                    childContainer.className = 'gyp-subchildren';
                    childContainer.style.display = 'none';
                    childContainer.style.listStyle = 'none';
                    childContainer.style.margin = '0';
                    childContainer.style.padding = '0';
                    container.appendChild(childContainer);

                    // 递归渲染子文件
                    renderFileList(childContainer, f.subfiles, depth + 1);

                    // 添加展开/收起事件
                    var toggle = li.querySelector('.gyp-subtoggle');
                    if (toggle && toggle.textContent) {
                        toggle.addEventListener('click', function () {
                            var expanded = toggle.dataset.expanded === 'true';
                            if (expanded) {
                                childContainer.style.display = 'none';
                                toggle.textContent = '▶';
                                toggle.dataset.expanded = 'false';
                            } else {
                                childContainer.style.display = 'block';
                                toggle.textContent = '▼';
                                toggle.dataset.expanded = 'true';
                            }
                        });
                    }

                    // 添加文件夹checkbox事件：全选/取消全选子文件
                    var checkbox = li.querySelector('.gyp-check');
                    if (checkbox) {
                        checkbox.addEventListener('change', function () {
                            var checked = checkbox.checked;
                            // 找到此文件夹下的所有子checkbox
                            var childChecks = childContainer.querySelectorAll('.gyp-check');
                            childChecks.forEach(function (c) {
                                c.checked = checked;
                                c.indeterminate = false;
                                // 触发子checkbox的change事件，以处理嵌套文件夹
                                c.dispatchEvent(new Event('change'));
                            });
                        });
                    }
                }
            });
        }

        var list = body.querySelector('.gyp-sublist');
        renderFileList(list, subfiles, 0);

        // 初始化所有文件夹的状态
        function initFolderCheckboxes(container) {
            var folders = container.querySelectorAll('.gyp-subitem');
            folders.forEach(function (item) {
                // 获取下一个兄弟元素，如果是gyp-subchildren说明这是文件夹
                var next = item.nextElementSibling;
                if (next && next.classList && next.classList.contains('gyp-subchildren')) {
                    var childChecks = next.querySelectorAll('.gyp-check');
                    if (childChecks.length > 0) {
                        var checkbox = item.querySelector('.gyp-check');
                        if (checkbox) {
                            var allChecked = Array.prototype.every.call(childChecks, function (c) { return c.checked; });
                            var noneChecked = Array.prototype.every.call(childChecks, function (c) { return !c.checked; });
                            checkbox.checked = allChecked;
                            checkbox.indeterminate = !allChecked && !noneChecked;
                        }
                    }
                }
            });
        }
        initFolderCheckboxes(list);

        var toggleBtn = body.querySelector('.gyp-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', function () {
                var checks = body.querySelectorAll('.gyp-check');
                // 只统计文件的选中状态，不统计文件夹
                var fileChecks = Array.prototype.filter.call(checks, function (c) {
                    var idx = Number(c.dataset.i);
                    var fileInfo = allFiles[idx];
                    return fileInfo && fileInfo.file.isDir !== true;
                });
                var allChecked = Array.prototype.every.call(fileChecks, function (c) { return c.checked; });
                Array.prototype.forEach.call(fileChecks, function (c) {
                    c.checked = !allChecked;
                    c.dispatchEvent(new Event('change'));
                });
            });
        }

        setStatus(status, '解析完成，请选择文件后点击”立即添加”', '');

        // “添加到”目录选择 - 先显示当前选择，然后尝试查找”来自：云添加”
        updateFolderPickRow(body, getSelectedFolder());
        var folderPick = body.querySelector('.gyp-folder-pick');
        if (folderPick) {
            folderPick.addEventListener('click', function () {
                openFolderPicker(function (picked) {
                    setSelectedFolder(picked);
                    updateFolderPickRow(body, picked);
                });
            });
        }

        // 如果还没有保存的目录，自动加载目录列表并查找"来自：云添加"
        if (!GM_getValue('gyp_selected_folder', null)) {
            fetchFileList('').then(function (folders) {
                var targetFolder = null;
                folders.forEach(function (f) {
                    if (f.fileName === '来自：云添加') {
                        targetFolder = {
                            id: f.fileId,
                            name: f.fileName,
                            path: [f.fileName]
                        };
                    }
                });
                if (targetFolder) {
                    setSelectedFolder(targetFolder);
                    updateFolderPickRow(body, targetFolder);
                }
            }).catch(function (e) {
                // 静默失败，不影响用户使用
            });
        }

        // 立即添加 → create_task
        addBtn.onclick = function () {
            var checks = body.querySelectorAll('.gyp-check:checked');
            // 只收集文件的索引，不收集文件夹的索引
            var indexes = [];
            Array.prototype.forEach.call(checks, function (c) {
                var idx = Number(c.dataset.i);
                var fileInfo = allFiles[idx];
                if (fileInfo && fileInfo.file.isDir !== true) {
                    // 传递接口返回的 fileIndex；无此字段时默认 0
                    var fIndex = fileInfo.file.fileIndex;
                    indexes.push(fIndex != null ? fIndex : 0);
                }
            });
            if (indexes.length === 0) {
                setStatus(status, '请至少选择一个文件', 'err');
                return;
            }
            var folder = getSelectedFolder();
            var newNameInput = body.querySelector('.gyp-newname');
            var reqBody = {
                fileIndexes: indexes,
                url: url,
                parentId: folder.id,
                newName: (newNameInput && newNameInput.value || '').trim() || newName
            };
            addBtn.disabled = true;
            setStatus(status, '正在创建任务…', '');
            gmRequest('POST', CREATE_URL, reqBody).then(function (r) {
                var ret = parseApiResult(r);
                if (ret.ok) {
                    setStatus(status, '✓ 添加成功！任务已创建', 'ok');
                    addBtn.textContent = '完成';
                    addBtn.disabled = false;
                    addBtn.onclick = closeOverlay;
                } else {
                    setStatus(status, '添加失败：' + ret.msg, 'err');
                    addBtn.disabled = false;
                }
            }).catch(function (e) {
                setStatus(status, '添加请求失败：' + e.message, 'err');
                addBtn.disabled = false;
            });
        };
    }
})();
