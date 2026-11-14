// ==UserScript==
// @name         kalodata商品排行榜-复制助手
// @name:zh-CN   kalodata商品排行榜-复制助手
// @namespace    workbuddy/kalodata-product-split
// @version      2.5.0
// @description  只在 https://www.kalodata.com/product 生效：网页本体按「1920 屏留 1560」的规则占宽，空出的那一侧做自建面板（宽度可自由拖，低于 200 自动收起）。面板内是商品中文翻译卡，与页面表格逐行滚动对齐；关键词回车即存为高亮、整卡点选导出 Excel（列宽与行高固定）。
// @author       zz
// @match        https://www.kalodata.com/product
// @match        https://www.kalodata.com/product/
// @include      /^https?:\/\/(www\.)?kalodata\.com\/product\/?(\?.*)?$/
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * 文件结构（自底向上，每层只调用它上面的层）
 *   §0   配置常量      尺寸 / 行为 / 存储键
 *   §0.5 路由门        非 /product 直接退出
 *   §1   通用工具      纯函数
 *   §2   原生读数探针  伪装前快照原生 getter
 *   §3   布局计算      真实宽度 → 分区方案
 *   §4   状态仓库      单一数据源 + 订阅广播
 *   §5   样式层        唯一 CSS 注入点，尺寸走 CSS 变量
 *   §6   伪装层        改写 innerWidth / clientWidth / visualViewport
 *   §7   视图层        面板 / 分隔线 / 拖动气泡 / 迷你停靠条
 *   §8   控制器        装配 / 事件 / 持久化 / 路由进出
 *   §9   启动          DOM 就绪钩子 + init
 *   §10  业务 · 数据   采集 → 翻译 → XLSX 打包
 *   §11  业务 · 展示   商品卡 / 高亮 / 滚动对齐 / 设置
 *
 * @run-at document-start + @grant none：脚本运行在页面上下文，
 * 可在页面脚本之前改写窗口读数，defineProperty 直接作用于页面 window。
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════
   * §0  配置
   * ═══════════════════════════════════════════════════════════════════════ */

  const CONFIG = {
    // —— 尺寸约束（以「预留区宽度」为准）——
    // 1920 屏：网页 1560 + 预留区 360；更宽的屏预留区封顶 360，
    // 更窄的屏先压预留区，下限 320，再窄就按「网页至少 200」让位。
    BASE_VIEW_W: 1920,      // 基准屏宽
    HOST_TARGET_W: 1560,    // 基准屏下留给网页的宽度
    PANEL_BASE_W: 360,      // 基准屏下预留区宽度 = BASE_VIEW_W - HOST_TARGET_W
    PANEL_MIN_W: 320,       // 自动公式的下限（手动拖拽不受此约束）
    PANEL_MAX_W: 360,       // 自动公式的上限（手动拖拽不受此约束）
    PANEL_FLOOR_W: 200,     // 手动宽度的下限：窄于此值就直接收起预留区
    HOST_FLOOR_W: 320,      // 手动宽度的上限依据：网页至少保留这么宽
    SNAP_RADIUS: 14,        // 吸附半径（px）

    // —— 行为默认值 ——
    DEFAULT_SIDE: 'left',   // 预留区默认在左侧：'left' | 'right'

    // —— 外观 ——
    // ALPHA 只作用于面板 / 顶栏 / 卡片 / 输入框的底色，文字固定为 hex 不透明，
    // 取值 0.35~1，用于看清面板背后漏过来的页面内容。
    UI: {
      ALPHA: 1,
      ALPHA_MIN: 35,        // 滑块下限（%）
      ALPHA_MAX: 100
    },

    // —— 路由门 ——
    // @match 无法约束 query，脚本内再判一次路径（/product 与 /product/ 都放行）
    ROUTE: {
      path: '/product',
      allowHosts: ['www.kalodata.com', 'kalodata.com']
    },

    // —— 内部标识 ——
    STORAGE_KEY: 'kdp-split-cfg',       // 面板偏好（side / panelW / enabled / alpha）
    EXPORT_CFG_KEY: 'kdp-export-cfg',   // 导出偏好（只存扩展列开关）
    WEB_CFG_KEY: 'kdp-web-cfg',         // 网页优化开关（省内存 / 懒翻译 / 拦埋点）
    MARK_KEY: 'kdp-highlight-marks',    // 高亮词库（字符串数组）
    STYLE_ID: 'kdp-split-style',
    LAYER_ID: 'kdp-split-layer',
    HTML_FLAG: 'data-kdp-split',     // html 上的开关属性，'on' 时才生效
    DRAG_FLAG: 'data-kdp-dragging',  // 拖动态单独一个属性，不与 HTML_FLAG 抢值
    /*
     * 宿主层级取 40：高于表格（sticky 表头 2 / 吸底条 10 / hover 层 20），
     * 低于站点下拉与弹层（1111），保证面板压住表格但不遮住站点的浮层。
     */
    Z_INDEX: '40',

    DEBUG: true
  };

  const SIDE = { LEFT: 'left', RIGHT: 'right' };
  const ACT = { SIDE: 'side', TOGGLE: 'toggle', VIEW: 'view', REFRESH: 'refresh' };

  /* ═══════════════════════════════════════════════════════════════════════
   * §0.5  路由门
   *
   *  主机名 + 路径 = /product 才继续；否则整个 IIFE 直接返回，
   *  不注入样式、不改 getter、不建定时器。
   * ═══════════════════════════════════════════════════════════════════════ */

  const Gate = {
    matches(href) {
      let url;
      try { url = new URL(href || location.href); } catch (e) { return false; }
      if (CONFIG.ROUTE.allowHosts.indexOf(url.hostname) === -1) return false;
      // 去掉末尾斜杠再比，避免 /product/ 漏判
      return url.pathname.replace(/\/+$/, '') === CONFIG.ROUTE.path;
    }
  };

  if (!Gate.matches()) {
    if (CONFIG.DEBUG) {
      console.info('[KDP] 路由未命中（需要 /product），脚本不启动:', location.href);
    }
    return;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * §1  通用工具（纯函数）
   * ═══════════════════════════════════════════════════════════════════════ */

  const Util = {
    clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    },

    /** 透明度（0~1）统一夹取，上下限只认 CONFIG.UI.ALPHA_MIN / ALPHA_MAX 一处 */
    clampAlpha(value) {
      const max = CONFIG.UI.ALPHA_MAX / 100;
      const num = typeof value === 'number' && isFinite(value) ? value : max;
      return this.clamp(num, CONFIG.UI.ALPHA_MIN / 100, max);
    },

    /** 在规定的时间窗口内最多执行一次 */
    debounce(fn, wait) {
      let timer = null;
      const wrapped = function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; fn.apply(this, args); }, wait);
      };
      wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      return wrapped;
    },

    /** 安全读取 localStorage 里的 JSON 对象 */
    readJSON(key) {
      try {
        const raw = localStorage.getItem(key);
        const value = raw ? JSON.parse(raw) : null;
        return value && typeof value === 'object' ? value : null;
      } catch (e) {
        return null;
      }
    },

    writeJSON(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 隐身模式等场景忽略 */ }
    },

    removeKey(key) {
      try { localStorage.removeItem(key); } catch (e) {}
    },

    log(...args) {
      if (CONFIG.DEBUG) console.log('%c[KDP-SPLIT]', 'color:#0369a1;font-weight:600', ...args);
    },

    /** HTML 转义：业务文本写进 innerHTML 前统一走这里 */
    esc(text) {
      return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §2  原生读数探针
   *  在 §6 安装任何 getter 之前快照原生描述符，内部始终能读到浏览器真实值。
   * ═══════════════════════════════════════════════════════════════════════ */

  const NativeProbe = (() => {
    const descriptorOf = (proto, prop) => {
      try { return Object.getOwnPropertyDescriptor(proto, prop); } catch (e) { return null; }
    };

    // 快照：调用时绕开脚本自己的覆盖，永远拿到浏览器真实值
    const innerWidthDesc = descriptorOf(window, 'innerWidth');
    const clientWidthDesc = descriptorOf(Element.prototype, 'clientWidth');

    const call = (desc, target, fallback) => {
      try {
        if (desc && typeof desc.get === 'function') return desc.get.call(target);
        return fallback();
      } catch (e) {
        return fallback();
      }
    };

    return {
      innerWidth() {
        return call(innerWidthDesc, window, () => window.innerWidth || 0) || 0;
      },
      /** 元素真实 clientWidth（不受 documentElement / body 上的覆盖影响） */
      clientWidth(element) {
        return call(clientWidthDesc, element, () => element.clientWidth || 0) || 0;
      }
    };
  })();

  /* ── 滚动条宽度测量（结果缓存，避免反复插 DOM） ─────────────────────── */
  const Scrollbar = {
    width: -1,
    dpr: 0,

    measure() {
      const de = document.documentElement;
      if (!de) return 0;
      const probe = document.createElement('div');
      probe.setAttribute('data-kdp-probe', '');
      probe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:100px;height:100px;' +
        'overflow:scroll;visibility:hidden;pointer-events:none;';
      de.appendChild(probe);
      const width = probe.offsetWidth - probe.clientWidth;
      probe.remove();
      return width > 0 ? width : 0;
    },

    get() {
      const dpr = window.devicePixelRatio || 1;
      if (this.width < 0 || this.dpr !== dpr) {   // 浏览器缩放会改变滚动条像素宽度
        this.width = this.measure();
        this.dpr = dpr;
      }
      return this.width;
    }
  };

  /**
   * 视口可用宽度。
   *
   * 插一个 position:fixed; width:100%; height:1px 的探针读 offsetWidth：
   * fixed 的包含块是初始包含块，量到的就是扣掉经典滚动条后的排版宽度，
   * 且脱离文档流，不会引起页面重排。量完立即移除。
   *
   * 用 offsetWidth 而非 getBoundingClientRect().width：后者在浏览器缩放时
   * 返回视觉像素，offsetWidth 是布局像素，与 clientWidth 同口径。
   */
  const Viewport = {
    measure() {
      const de = document.documentElement;
      if (!de) return 0;
      const probe = document.createElement('div');
      probe.setAttribute('data-kdp-probe', '');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:1px;' +
        'visibility:hidden;pointer-events:none;';
      de.appendChild(probe);
      let width = 0;
      try {
        width = probe.offsetWidth || probe.getBoundingClientRect().width || 0;
      } finally {
        probe.remove();
      }
      return width > 400 ? Math.round(width) : 0;
    }
  };

  /** 真实排版宽度：探针优先，兜底用 innerWidth 扣滚动条 */
  function measureLayoutWidth() {
    const innerWidth = NativeProbe.innerWidth();

    // ① 探针值要和 innerWidth 交叉校验（差值 1~40px 内才采信）。
    //    <html> 若有 transform/filter，fixed 包含块会退化，探针会读到收窄的宿主宽度。
    const probed = Viewport.measure();
    if (probed > 400 && (!(innerWidth > 400) ||
        (probed <= innerWidth + 1 && probed >= innerWidth - 40))) {
      return probed;
    }

    // ② 兜底：innerWidth 扣掉实测滚动条宽度（量不到就按典型值 17 扣）
    if (innerWidth > 400) {
      const scrollbarW = Scrollbar.get() || 17;
      return Math.round(innerWidth - scrollbarW);
    }

    return 1920;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * §3  布局计算（纯函数，无 DOM、无副作用）
   * ═══════════════════════════════════════════════════════════════════════ */

  const Layout = {
    /**
     * 唯一的规则：先定预留区宽度，剩下的全给网页。
     *   自动（未手动设过）：panel = clamp(realW - 1560, 320, 360)
     *   手动（拖过 / 填过数）：panel = clamp(值, 200, realW - 320)，不再受 320~360 约束
     *   手动值窄于 200：视为收起，canSplit = false
     *
     * @returns {{realW:number,hostW:number,reserveW:number,canSplit:boolean}}
     */
    compute(realW, options) {
      const opts = options || {};
      const manual = typeof opts.userPanelW === 'number' && isFinite(opts.userPanelW);
      const hostFloor = Math.min(CONFIG.HOST_FLOOR_W, Math.max(0, Math.round(realW - CONFIG.PANEL_FLOOR_W)));

      let panelW = manual ? opts.userPanelW : realW - CONFIG.HOST_TARGET_W;
      const lower = manual ? 0 : CONFIG.PANEL_MIN_W;
      const upper = manual
        ? Math.max(CONFIG.PANEL_FLOOR_W, realW - hostFloor)
        : CONFIG.PANEL_MAX_W;

      panelW = Util.clamp(panelW, lower, upper);
      // 极窄视口（窗口被压到 600 以内）时不硬塞 320，给网页留至少 200
      panelW = Math.min(panelW, Math.max(0, Math.round(realW - 200)));

      const reserveW = Math.max(0, Math.round(panelW));
      const hostW = Math.round(realW - reserveW);

      return {
        realW,
        hostW,
        reserveW,
        canSplit: reserveW >= (manual ? CONFIG.PANEL_FLOOR_W : 1)
      };
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §4  状态仓库（单一数据源）
   * ═══════════════════════════════════════════════════════════════════════ */

  const Store = {
    state: {
      realW: 0,                      // 真实排版视口宽度
      hostW: CONFIG.HOST_TARGET_W,   // 伪装给页面的宽度 = 页面实际占用宽度
      reserveW: CONFIG.PANEL_BASE_W, // 预留区宽度
      side: CONFIG.DEFAULT_SIDE,
      enabled: true,                 // 分区是否开启（= 预留区是否可见）
      userPanelW: null,              // 用户拖拽后的固定预留区宽度；null = 跟随公式
      canSplit: true,                // 当前窗口是否还有地方给预留区
      view: 'show',                  // 'show' 展示界面 | 'debug' 设置界面（互斥）
      alpha: CONFIG.UI.ALPHA         // 面板底色不透明度（0.35~1），文字恒定不透明
    },

    listeners: [],

    subscribe(fn) {
      this.listeners.push(fn);
      return () => {
        const index = this.listeners.indexOf(fn);
        if (index >= 0) this.listeners.splice(index, 1);
      };
    },

    /** 合并状态并广播（广播只做视图更新，不做重计算，避免环） */
    patch(partial) {
      let changed = false;
      for (const key in partial) {
        if (Object.prototype.hasOwnProperty.call(partial, key) && this.state[key] !== partial[key]) {
          this.state[key] = partial[key];
          changed = true;
        }
      }
      if (changed) this.listeners.forEach((fn) => fn(this.state));
      return changed;
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §5  样式层（唯一 CSS 注入点）
   *  所有尺寸都走 CSS 变量：拖动时只改变量、不重写样式表，
   *  浏览器把同一帧的多次变量写入合并成一次布局计算，不会闪动。
   * ═══════════════════════════════════════════════════════════════════════ */

  const StyleLayer = {
    element: null,
    lastMetrics: '',
    lastAlpha: -1,

    ensure() {
      if (this.element && this.element.isConnected) return this.element;
      let style = document.getElementById(CONFIG.STYLE_ID);
      if (!style) {
        const hostEl = document.head || document.documentElement;
        if (!hostEl) return null;               // 极早期还没有 <html>
        style = document.createElement('style');
        style.id = CONFIG.STYLE_ID;
        hostEl.appendChild(style);
      }
      this.element = style;
      return style;
    },

    /** 注入宿主收窄规则：只在 html[data-kdp-split="on"] 下生效，关掉即整页复原 */
    install() {
      const style = this.ensure();
      if (!style) return;
      const flag = `html[${CONFIG.HTML_FLAG}="on"]`;
      const hostW = `var(--kdp-host-w, ${CONFIG.HOST_TARGET_W}px)`;

      const rules = [
        /* ① html：整页排版盒收窄，并按侧边让出 gap 的位移 */
        `${flag}{`,
        `  width:${hostW} !important;`,
        `  max-width:${hostW} !important;`,
        `  min-width:0 !important;`,
        `  margin-left:var(--kdp-gap, 0px) !important;`,
        `  margin-right:var(--kdp-gap-r, 0px) !important;`,
        `  overflow-x:hidden !important;`,
        `}`,
        /* ② body 同步，避免子元素按 body 自然宽度撑开 */
        `${flag} body{`,
        `  width:${hostW} !important;`,
        `  max-width:${hostW} !important;`,
        `  overflow-x:hidden !important;`,
        `}`,
        /* ③ 站点根排版容器 .page 自带 min-width:1280px，钉成宿主宽度 */
        `${flag} .app,`,
        `${flag} .app_login_wrapper,`,
        `${flag} .page{`,
        `  width:${hostW} !important;`,
        `  max-width:${hostW} !important;`,
        `  min-width:0 !important;`,
        `}`,
        /* ④ 拖动时全局锁光标，鼠标划过任何元素都保持左右箭头 */
        `html[${CONFIG.DRAG_FLAG}] *{`,
        `  cursor:col-resize !important;`,
        `  user-select:none !important;`,
        `}`
      ];

      style.textContent = rules.join('\n');
    },

    /** 只改变量：一次 style 变更，浏览器合并成一次布局计算 */
    setMetrics(hostW, reserveW, gapLeft, gapRight) {
      const de = document.documentElement;
      if (!de) return;
      const right = typeof gapRight === 'number' ? gapRight : 0;
      const key = hostW + '|' + reserveW + '|' + gapLeft + '|' + right;
      if (key === this.lastMetrics) return;     // 值没变就别碰样式，避免无意义的重排
      this.lastMetrics = key;
      de.style.setProperty('--kdp-host-w', hostW + 'px');
      de.style.setProperty('--kdp-reserve-w', reserveW + 'px');
      de.style.setProperty('--kdp-gap', gapLeft + 'px');
      de.style.setProperty('--kdp-gap-r', right + 'px');
    },

    /** 面板「面」的不透明度：只写 --kdp-a，文字颜色不受影响 */
    setAlpha(alpha) {
      const de = document.documentElement;
      if (!de) return;
      const value = Util.clampAlpha(alpha);
      if (value === this.lastAlpha) return;
      this.lastAlpha = value;
      de.style.setProperty('--kdp-a', String(value));
    },

    /** 分区开关：on 才应用上面的所有规则；off 时页面完全回到原样 */
    setEnabled(enabled) {
      const de = document.documentElement;
      if (!de) return;
      if (enabled) de.setAttribute(CONFIG.HTML_FLAG, 'on');
      else de.removeAttribute(CONFIG.HTML_FLAG);
    },

    setDragging(dragging) {
      const de = document.documentElement;
      if (!de) return;
      if (dragging) de.setAttribute(CONFIG.DRAG_FLAG, '');
      else de.removeAttribute(CONFIG.DRAG_FLAG);
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §6  伪装层（宽度读数）
   *  关闭分区时必须返回真实值；否则「隐藏预留区后宽度不恢复」。
   * ═══════════════════════════════════════════════════════════════════════ */

  const Spoofer = {
    installed: false,

    /** 当前应该对外报告的宽度 */
    reportedWidth() {
      return Store.state.enabled ? Store.state.hostW : NativeProbe.innerWidth();
    },

    defineGetter(target, prop, getter) {
      if (!target) return;
      try {
        Object.defineProperty(target, prop, { configurable: true, enumerable: true, get: getter });
      } catch (e) { /* 个别属性不可重定义，忽略 */ }
    },

    /** window 级伪装：不需要 DOM，document-start 阶段即可安装 */
    installWindow() {
      if (this.installed) return;
      this.installed = true;

      const width = () => this.reportedWidth();
      this.defineGetter(window, 'innerWidth', width);
      this.defineGetter(window, 'outerWidth', width);

      const vv = window.visualViewport;
      if (vv) {
        this.defineGetter(vv, 'width', width);
        this.defineGetter(vv, 'offsetLeft', () => 0);
      }
    },

    /** 元素级伪装：关闭分区时返回元素真实值，不能虚报 */
    installDocument() {
      const de = document.documentElement;
      if (!de) return;
      this.defineGetter(de, 'clientWidth', () =>
        Store.state.enabled ? Store.state.hostW : NativeProbe.clientWidth(de));
    },

    installBody() {
      const body = document.body;
      if (!body) return;
      this.defineGetter(body, 'clientWidth', () =>
        Store.state.enabled ? Store.state.hostW : NativeProbe.clientWidth(body));
      // 不覆盖 scrollWidth：getter 里读自己会无限递归，且布局收窄后它本来就是对的。
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §7  视图层
   *  全部 UI 装在一个 shadow root 里：
   *   · 与站点 CSS 完全隔离，不用跟站点选择器打架
   *   · 一个 fixed 全屏容器 + pointer-events 分层，不挡页面点击
   * ═══════════════════════════════════════════════════════════════════════ */

  /* ---------- §7.0 视图样式 ---------- */

  const VIEW_CSS = `
    *,*::before,*::after{box-sizing:border-box}

    .layer{
      position:absolute;inset:0;
      font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
      color:#334155;
      pointer-events:none;              /* 只让具体控件接管点击 */
    }

    /* ---------- 预留区面板 ---------- */
    .panel{
      position:absolute;top:0;bottom:0;
      display:flex;flex-direction:column;
      /* 只有「面」带 alpha；文字颜色是写死的 hex，永远不透明 */
      background:rgba(248,250,252,var(--kdp-a,1));
      pointer-events:auto;
      overflow:hidden;
    }
    .panel[data-side="left"]{
      left:0;width:var(--kdp-reserve-w,0px);
      border-right:1px solid rgba(203,213,225,var(--kdp-a,1));
    }
    .panel[data-side="right"]{
      left:var(--kdp-host-w,1600px);right:0;
      border-left:1px solid rgba(203,213,225,var(--kdp-a,1));
    }
    .panel[hidden]{display:none}

    /* ---------- 顶栏（状态栏） ---------- */
    .panel-head{
      flex:0 0 auto;height:38px;
      display:flex;align-items:center;gap:6px;
      padding:0 6px 0 9px;
      background:rgba(255,255,255,var(--kdp-a,1));
      border-bottom:1px solid rgba(226,232,240,var(--kdp-a,1));
    }
    .panel-title{
      display:flex;align-items:center;gap:5px;
      font-weight:600;font-size:12.5px;color:#0f172a;white-space:nowrap;flex:0 0 auto;
    }
    .panel-title .dot{width:6px;height:6px;border-radius:50%;background:#3b82f6;flex:0 0 auto}
    .panel-meta{
      margin-left:auto;display:flex;align-items:center;gap:2px;min-width:0;
      color:#94a3b8;font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;
    }
    .panel-meta b{color:#475569;font-weight:600}

    /* 顶栏那个可编辑的宽度数字 */
    .meta-num{
      width:38px;padding:1px 3px;margin:0;
      border:1px solid transparent;border-radius:4px;
      background:transparent;color:#475569;font:inherit;font-weight:600;font-size:11.5px;
      font-variant-numeric:tabular-nums;text-align:right;
      pointer-events:auto;outline:none;cursor:text;
      transition:background .12s,border-color .12s,box-shadow .12s;
    }
    .meta-num:hover{background:#f1f5f9;border-color:#e2e8f0}
    .meta-num:focus{
      background:#fff;border-color:#3b82f6;color:#0f172a;
      box-shadow:0 0 0 2px rgba(59,130,246,.18);
    }
    .panel-actions{display:flex;align-items:center;gap:2px;margin-left:2px}

    .icon-btn{
      width:26px;height:26px;padding:0;border:0;border-radius:6px;
      display:flex;align-items:center;justify-content:center;
      background:transparent;color:#64748b;cursor:pointer;
      transition:background .12s,color .12s;
    }
    .icon-btn:hover{background:#f1f5f9;color:#0f172a}
    .icon-btn:active{background:#e2e8f0}
    .icon-btn svg{width:15px;height:15px;display:block}

    .panel-body{flex:1 1 auto;min-height:0;overflow:hidden;display:flex;flex-direction:column}

    /* ---------- 展示 / 设置 两个互斥视图 ---------- */
    .view{display:none;flex:1 1 auto;min-height:0;flex-direction:column}
    .view.on{display:flex}

    /* 可滚动区：滚动条只出现在正文里，顶栏永远不动 */
    .scroll{
      flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;
      padding:10px 10px 0;display:flex;flex-direction:column;gap:8px;
    }

    /* 展示界面：整块由 §11 铺满，内部只有商品列表滚动 */
    .sp-wrap{
      flex:1 1 auto;min-height:0;display:flex;flex-direction:column;
      padding:8px 8px 6px;
    }

    /* 空态占位卡 */
    .stub{
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
      min-height:180px;padding:18px 14px;border-radius:9px;
      background:rgba(255,255,255,var(--kdp-a,1));
      border:1px dashed rgba(203,213,225,var(--kdp-a,1));
      color:#94a3b8;font-size:12px;line-height:1.7;text-align:center;
    }
    .stub b{color:#475569;font-size:12.5px;font-weight:600}

    /* ---------- 分隔线（拖拽手柄） ---------- */
    .divider{
      position:absolute;top:0;bottom:0;width:13px;
      cursor:col-resize;pointer-events:auto;
      display:flex;align-items:center;justify-content:center;
      touch-action:none;
    }
    .divider[data-side="left"]{left:calc(var(--kdp-reserve-w,0px) - 6px)}
    .divider[data-side="right"]{left:calc(var(--kdp-host-w,1600px) - 6px)}
    .divider[hidden]{display:none}

    .divider .line{
      width:2px;height:100%;border-radius:2px;
      background:transparent;transition:background .14s;
    }
    .divider .grip{
      position:absolute;width:6px;height:40px;border-radius:99px;
      background:#94a3b8;box-shadow:0 0 0 3px rgba(255,255,255,.85);
      opacity:0;transition:opacity .14s,background .14s,height .14s;
    }
    .divider:hover .line{background:rgba(59,130,246,.55)}
    .divider:hover .grip{opacity:1;background:#3b82f6}
    .divider.snap .line{background:rgba(34,197,94,.6)}
    .divider.snap .grip{opacity:1;background:#22c55e;height:56px}
    .divider.dragging .line{background:rgba(59,130,246,.8)}
    .divider.dragging.snap .line{background:rgba(34,197,94,.9)}

    /* ---------- 拖动气泡 ---------- */
    .bubble{
      position:absolute;top:50%;transform:translate(-50%,-50%);
      padding:5px 10px;border-radius:8px;
      background:rgba(15,23,42,.9);color:#fff;
      font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;
      pointer-events:none;opacity:0;transition:opacity .12s;
    }
    .bubble.show{opacity:1}
    .bubble.snap{background:rgba(22,163,74,.95)}

    /* ---------- 收起后的迷你停靠条（也是恢复入口，必须能被看见） ---------- */
    .mini{
      position:fixed;top:50%;transform:translateY(-50%);
      display:flex;flex-direction:column;gap:2px;
      padding:4px 3px;border-radius:9px;
      background:rgba(255,255,255,var(--kdp-a,1));
      border:1px solid rgba(203,213,225,var(--kdp-a,1));
      box-shadow:0 3px 12px rgba(15,23,42,.14);
      pointer-events:auto;
      opacity:.92;transition:opacity .15s,box-shadow .15s;
      z-index:1;
    }
    .mini::after{
      content:"";position:absolute;top:8px;right:-3px;width:5px;height:5px;
      border-radius:50%;background:#3b82f6;
    }
    .mini[data-side="left"]{left:6px}
    .mini[data-side="left"]::after{right:auto;left:-3px}
    .mini[data-side="right"]{right:6px;left:auto}
    .mini:hover{opacity:1;box-shadow:0 4px 16px rgba(15,23,42,.2)}
    .mini[hidden]{display:none}
    .mini button{
      width:22px;height:22px;border:0;border-radius:5px;background:transparent;
      color:#475569;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;
    }
    .mini button:hover{background:#eff6ff;color:#1d4ed8}
    .mini button svg{width:14px;height:14px;display:block}

    /* ---------- 提示条 ---------- */
    .toast{
      position:fixed;left:50%;bottom:20px;z-index:2;
      transform:translateX(-50%) translateY(6px);
      max-width:min(78vw,420px);padding:6px 12px;border-radius:99px;
      background:rgba(15,23,42,.92);color:#fff;font-size:11.5px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      opacity:0;pointer-events:none;transition:opacity .15s,transform .15s;
    }
    .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}

    /* ---------- 设置界面 ---------- */
    .dbg-scroll{padding:10px 10px 14px}
    .dbg{display:flex;flex-direction:column;gap:9px;font-size:12px}
    .grp{
      border:1px solid rgba(238,242,247,var(--kdp-a,1));border-radius:8px;
      padding:7px 8px 8px;background:rgba(252,253,255,var(--kdp-a,1));
    }
    .grp-h{
      display:flex;align-items:baseline;justify-content:space-between;gap:6px;
      font:600 11px/1.6 system-ui,sans-serif;color:#334155;margin-bottom:5px;
    }
    .grp-h em{font-style:normal;font:400 10px/1.6 system-ui,sans-serif;color:#a3b1c2}

    .fld{display:flex;align-items:center;gap:6px;padding:1px 0}
    .fld .k{flex:0 0 82px;color:#7b8aa0;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    /* 透明度滑块：原生 range，只统一高度与配色，零 JS 绘制 */
    .fld .rng{flex:1 1 auto;min-width:0;height:16px;margin:0;accent-color:#2563eb;cursor:pointer}
    .fld .pct{flex:0 0 32px;text-align:right;color:#64748b;font-size:10.5px;font-variant-numeric:tabular-nums}
    .grp > .sub{display:block;margin:4px 0 0;color:#a3b1c2;font-size:10.5px;font-style:normal;line-height:1.45}

    .dbg .row{display:flex;gap:6px}
    .dbg .row button{
      flex:1 1 0;height:27px;border:1px solid rgba(219,227,236,var(--kdp-a,1));border-radius:6px;
      background:rgba(255,255,255,var(--kdp-a,1));
      color:#475569;font:600 11.5px/1 system-ui,sans-serif;cursor:pointer;
    }
    .dbg .row button:hover{background:#f8fafc;border-color:#cbd5e1}

    .dbg .note{color:#a3b1c2;font-size:10.5px;line-height:1.6}
    .dbg .note code{
      font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#94a3b8;
      background:#eef2f7;border-radius:3px;padding:0 3px;
    }
    .stack{display:flex;flex-direction:column;gap:9px}

    /*
     * 设置项：扩展列开关。3 列网格，按数组顺序每三个换一行；
     * 点文字即切换，标蓝 = 已加入导出。
     */
    .tags{display:grid;grid-auto-flow:row;grid-template-columns:repeat(3,1fr);gap:5px}
    .tag{
      display:block;width:100%;min-width:0;
      padding:5px 6px;border-radius:6px;
      border:1px solid rgba(226,232,240,var(--kdp-a,1));
      background:rgba(255,255,255,var(--kdp-a,1));
      color:#64748b;font:500 10.5px/1.2 system-ui,sans-serif;
      text-align:left;cursor:pointer;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      transition:background .12s,border-color .12s,color .12s;
    }
    .tag:hover{border-color:#c7ddff;color:#1d4ed8}
    .tag.on{background:#dbeafe;border-color:#93c5fd;color:#1d4ed8;font-weight:600}

    /* ═══════════ 展示页：工具条 / 搜索 / 高亮 / 商品卡 ═══════════ */

    .sp{display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:0}

    /* 第一行：导出、重新读取、已选统计 */
    .sp-bar{display:flex;align-items:center;gap:5px;flex:0 0 auto}
    .sp-btn{
      height:26px;padding:0 9px;
      border:1px solid rgba(219,227,236,var(--kdp-a,1));border-radius:6px;
      background:rgba(255,255,255,var(--kdp-a,1));
      color:#475569;font:600 11.5px/1 system-ui,sans-serif;cursor:pointer;
      white-space:nowrap;transition:background .12s,border-color .12s;
    }
    .sp-btn:hover{background:#f8fafc;border-color:#cbd5e1}
    .sp-btn:disabled{opacity:.55;cursor:default}
    .sp-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
    .sp-btn.primary:hover{background:#1d4ed8}
    /*
     * 工具条上的「重新读取」「全选」：灰黑边框 + 浅灰底 + 一圈内描边，
     * 与「清除」外观一致，但单独成规则，两者可各自调整。
     */
    .sp-btn-solid{
      border-color:#94a3b8;background:rgba(241,245,249,var(--kdp-a,1));color:#334155;
      box-shadow:0 0 0 1px rgba(15,23,42,.05);
    }
    .sp-btn-solid:hover{background:#e2e8f0;border-color:#64748b;color:#0f172a}
    /* 计数靠右；窄面板下允许自我压缩，绝不把工具条顶出边界 */
    .sp-count{
      margin-left:auto;color:#94a3b8;font-size:11px;
      font-variant-numeric:tabular-nums;white-space:nowrap;
      min-width:0;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;
    }
    .sp-count b{color:#475569;font-weight:600}

    /*
     * 第二行：关键词框 + 存 / 清除。
     * 输入框静止态是一圈品牌蓝细边，聚焦时补外发光表示正在输入。
     */
    .sp-search{display:flex;align-items:center;gap:4px;flex:0 0 auto}
    .sp-find{
      position:relative;flex:1 1 auto;min-width:0;display:flex;align-items:center;
    }
    .sp-find-ico{
      position:absolute;left:7px;width:12px;height:12px;
      color:#0191fb;opacity:.8;pointer-events:none;
    }
    .sp-input{
      flex:1 1 auto;min-width:0;width:100%;height:28px;padding:0 8px 0 24px;
      border:1px solid #0191fb;border-radius:7px;
      background:rgba(255,255,255,var(--kdp-a,1));
      color:#0b1f33;
      font:400 11.5px/1 system-ui,sans-serif;outline:none;
      transition:border-color .12s,box-shadow .12s;
    }
    .sp-input::placeholder{color:#8fb2d0}
    .sp-input:hover{border-color:#0177d0}
    .sp-input:focus{
      border-color:#0191fb;
      box-shadow:0 0 0 3px rgba(1,145,251,.2),0 2px 12px rgba(1,145,251,.25);
    }
    /* 搜索行里的按钮跟输入框同高，视觉才是一条线 */
    .sp-search .sp-btn{height:28px}
    /* 存：弱化强调，蓝字浅蓝底 */
    .sp-search .sp-btn-mark{
      border-color:rgba(1,145,251,.45);background:rgba(232,243,255,var(--kdp-a,1));color:#0369a1;
    }
    .sp-search .sp-btn-mark:hover{background:#dcecff;border-color:#0191fb;color:#075985}
    /* 清除：灰黑描边 + 浅灰底，与周围背景区分开 */
    .sp-search .sp-btn-clear{
      border-color:#94a3b8;background:rgba(241,245,249,var(--kdp-a,1));color:#334155;
      box-shadow:0 0 0 1px rgba(15,23,42,.05);
    }
    .sp-search .sp-btn-clear:hover{background:#e2e8f0;border-color:#64748b;color:#0f172a}

    /* 高亮词条：点了就删 */
    .sp-marks{display:flex;flex-wrap:wrap;gap:4px;flex:0 0 auto}
    .sp-chip{
      display:inline-flex;align-items:center;gap:2px;height:19px;
      padding:0 2px 0 6px;border-radius:99px;
      background:#fef3c7;border:1px solid #fde68a;color:#92400e;
      font-size:10.5px;line-height:1;white-space:nowrap;max-width:100%;
    }
    .sp-chip span{overflow:hidden;text-overflow:ellipsis}
    .sp-chip button{
      width:14px;height:14px;padding:0;border:0;border-radius:50%;
      background:transparent;color:#b45309;font-size:11px;line-height:1;
      cursor:pointer;flex:0 0 auto;
    }
    .sp-chip button:hover{background:#fde68a;color:#7c2d12}
    /* 词条本体可点：一键勾选/取消所有包含该词的商品 */
    .sp-chip .sp-chip-t{cursor:pointer}
    .sp-chip .sp-chip-t:hover{text-decoration:underline}
    /* 已全选：转绿并打勾，一眼看出这个词已经"吃"进去了 */
    .sp-chip.picked{background:#dcfce7;border-color:#86efac;color:#15803d}
    .sp-chip.picked .sp-chip-t::after{content:" ✓";font-weight:700}
    .sp-chip.picked button{color:#15803d}
    .sp-chip.picked button:hover{background:#bbf7d0;color:#14532d}

    /* 商品卡列表：唯一可滚动区，滚动不影响页面 */
    .sp-list{
      flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;
      display:flex;flex-direction:column;gap:5px;padding-right:1px;
    }
    /*
     * 一张卡 = 一件商品：整卡可点，点中即勾选，没有单独的复选框。
     * 三档状态：默认淡蓝底 / 悬停加深并加投影 / 选中蓝底 + 左侧品牌蓝竖条。
     */
    .sp-card{
      display:flex;align-items:flex-start;gap:8px;
      padding:7px 8px;border-radius:8px;
      border:1px solid rgba(191,219,254,var(--kdp-a,1));
      background:rgba(248,251,255,var(--kdp-a,1));
      cursor:pointer;
      transition:border-color .12s,background .12s,box-shadow .12s;
    }
    .sp-card:hover{
      border-color:#93c5fd;background:#eef6ff;
      box-shadow:0 1px 4px rgba(37,99,235,.1);
    }
    /* 勾选态：整块蓝底 + 左侧品牌蓝竖条 */
    .sp-card.on{
      border-color:#3b82f6;
      background:linear-gradient(120deg,#e8f3ff 0%,#dbeafe 100%);
      box-shadow:inset 3px 0 0 #0191fb,0 1px 5px rgba(1,145,251,.16);
    }
    .sp-card.on:hover{background:linear-gradient(120deg,#dcecff 0%,#cfe0fd 100%)}
    /* 当前对齐到页面首行的那一张（未选中时用细蓝边提示位置，选中后交给 .on） */
    .sp-card.cur{box-shadow:inset 3px 0 0 #3b82f6}
    .sp-card.cur.on{box-shadow:inset 3px 0 0 #0191fb,0 1px 5px rgba(1,145,251,.16)}
    .sp-thumb{
      width:58px;height:58px;border-radius:6px;object-fit:cover;display:block;flex:0 0 auto;
      background-color:rgba(241,245,249,var(--kdp-a,1));
      background-size:cover;background-position:center;background-repeat:no-repeat;
    }
    .sp-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
    /* 中文名占主要位置：最多 3 行，超出才截断；点它复制文本 */
    .sp-cn{
      font-size:12px;line-height:1.42;color:#000;font-weight:600;
      display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;
      overflow:hidden;word-break:break-word;
    }
    .sp-cn:hover{color:#1d4ed8}
    .sp-cn.pending{color:#cbd5e1;font-weight:400}
    /* 外文名：最多 2 行，尽量把名字留全 */
    .sp-en{
      font-size:10.5px;line-height:1.35;color:#94a3b8;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
      overflow:hidden;word-break:break-word;
    }
    .sp-meta{
      display:flex;gap:6px;align-items:baseline;
      font-size:9.5px;line-height:1.3;color:#a3b1c2;
      font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;
    }
    .sp-facts{display:flex;gap:6px;align-items:baseline;min-width:0;overflow:hidden}
    /* 上架时间贴最右，与左侧的序号 · 价格 · 销量分开 */
    .sp-date{margin-left:auto;flex:0 0 auto;color:#b9c5d2}
    .sp-rank{color:#64748b;font-weight:600}
    .sp-dot{color:#dbe3ec}
    /* 命中搜索 / 高亮词 */
    mark.sp-hit{background:#fde68a;color:#78350f;border-radius:2px;padding:0 1px}
    mark.sp-hit.search{background:#bfdbfe;color:#1e3a8a}

    /*
     * 悬停浮窗：超浅蓝渐变底 + 深色字 + 左侧品牌蓝竖条。
     * pointer-events:auto 让指针能移进浮窗而不触发卡片的离开逻辑。
     */
    .sp-tip{
      position:fixed;z-index:3;display:none;
      max-width:340px;padding:9px 11px;border-radius:9px;
      background:linear-gradient(120deg,#fbfdff 0%,#f7fcff 55%,#f5fdff 100%);
      color:#0b3050;
      border:1px solid rgba(1,145,251,.18);
      border-left:3px solid #0191fb;
      box-shadow:0 12px 26px rgba(1,110,200,.14),0 2px 8px rgba(1,110,200,.07);
      font-family:var(--kdp-font,system-ui,sans-serif);
      font-size:13px;line-height:1.6;
      /* 指针可以移进浮窗：读长标题时不会因为"离开卡片"就消失 */
      pointer-events:auto;
    }
    .sp-tip.on{display:block}
    .sp-tip .t-cn{font-size:13.5px;font-weight:400;color:#000;word-break:break-word}
    .sp-tip .t-en{
      margin-top:4px;font-size:12px;font-weight:400;color:#5c7288;word-break:break-word;
      padding-top:4px;border-top:1px solid rgba(1,145,251,.14);
    }
    .sp-tip .t-meta{
      margin-top:6px;font-size:11.5px;font-weight:400;color:#1a6ea8;
      font-variant-numeric:tabular-nums;
      display:flex;align-items:baseline;gap:8px;
    }
    /* 上架时间推到最右，和左边的 #序号 · 价格 · 销量 分开 */
    .sp-tip .t-date{margin-left:auto;color:#7c8ea0;white-space:nowrap}
  `;

  /* ---------- §7.0b 图标（线性图标，随文字色继承） ---------- */

  const ICON = {
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
    hide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="m10 9-3 3 3 3"/></svg>',
    show: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="m8 9 3 3-3 3"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>'
  };

  /* ---------- §7.1 视图容器 ---------- */

  const View = {
    host: null,
    root: null,
    refs: {},
    mounted: false,
    hold: false,            // 收回后置位：apply / 看门狗都不许把 UI 叫回来，直到 resume
    unsubscribe: null,

    mount() {
      if (this.mounted || !document.body) return;
      this.mounted = true;
      this.hold = false;

      // 外层宿主：fixed 全屏、零侵入，所有 UI 都在 shadow 内
      const host = document.createElement('div');
      host.id = CONFIG.LAYER_ID;
      host.style.cssText = [
        'position:fixed', 'inset:0',
        `z-index:${CONFIG.Z_INDEX}`,
        'pointer-events:none',
        'display:block'
      ].join(';');

      // 浮窗直接复用网页自身的字体：从 body 取一次，挂成自定义属性
      const pageFont = getComputedStyle(document.body).fontFamily;
      if (pageFont) host.style.setProperty('--kdp-font', pageFont);

      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = [
        `<style>${VIEW_CSS}</style>`,
        '<div class="layer">',
        '  <div class="panel" data-side="left" hidden>',
        '    <div class="panel-head">',
        '      <span class="panel-title"><span class="dot"></span>预留区</span>',
        '      <span class="panel-meta">',
        '        <input class="meta-num" data-ref="panelW" type="text" inputmode="numeric"',
        '               autocomplete="off" spellcheck="false" value="-"',
        '               title="点这里直接输入预留区宽度（≥200 生效，小于 200 即收起），回车生效；Esc 取消">',
        '        <span>px · 网页 <b data-ref="hostW">-</b></span>',
        '      </span>',
        '      <span class="panel-actions">',
        `        <button class="icon-btn" data-act="${ACT.REFRESH}" title="刷新面板内容">${ICON.refresh}</button>`,
        `        <button class="icon-btn" data-act="${ACT.VIEW}" title="设置（再点一次返回）">${ICON.gear}</button>`,
        `        <button class="icon-btn" data-act="${ACT.SIDE}" title="切换预留区到另一侧（Alt+X）">${ICON.swap}</button>`,
        `        <button class="icon-btn" data-act="${ACT.TOGGLE}" title="收起预留区，恢复整页宽（Alt+Z）">${ICON.hide}</button>`,
        '      </span>',
        '    </div>',
        '    <div class="panel-body">',

        /* ── 展示界面：工具条 / 搜索 / 商品翻译卡（内容由 §11 填充） ── */
        '      <div class="view view-show on">',
        '        <div class="sp-wrap" data-ref="content"></div>',
        '      </div>',

        /* ── 设置界面（内容留白，只保留框架自带的显示项） ── */
        '      <div class="view view-debug">',
        '        <div class="scroll dbg-scroll">',
        '          <div class="dbg">',
        '            <div class="grp">',
        '              <div class="grp-h"><span>面板透明度</span><em>只调底色，文字不透明</em></div>',
        '              <label class="fld"><span class="k">底色不透明度</span>',
        `                <input class="rng" data-ref="optAlpha" type="range" min="${CONFIG.UI.ALPHA_MIN}" max="${CONFIG.UI.ALPHA_MAX}" step="1" value="${CONFIG.UI.ALPHA * 100}">`,
        '                <span class="pct" data-ref="alphaVal">100%</span></label>',
        '              <em class="sub">只影响底色 / 白块 / 描边，文字颜色不变。</em>',
        '            </div>',

        /* 功能设置项由 §11 填充 */
        '            <div class="grp"><div class="grp-h"><span>功能设置</span><em>导出扩展列</em></div>',
        '              <div class="stack" data-ref="settings"></div>',
        '            </div>',

        /* 网页优化开关：每一项都能单独关掉 */
        '            <div class="grp"><div class="grp-h"><span>网页优化</span><em>可单独关掉</em></div>',
        '              <div class="stack" data-ref="webopt"></div>',
        '            </div>',

        /* 合并导出：挑多个导出的 xlsx，按表头拼成一份 */
        '            <div class="grp"><div class="grp-h"><span>合并导出文件</span><em>同一次任务的多份表</em></div>',
        '              <div class="row"><button data-dbg="merge">选择 xlsx 合并…</button></div>',
        '              <input type="file" data-ref="mergeInput" accept=".xlsx" multiple hidden>',
        '              <em class="sub">选中多份导出文件，表头只保留第一份，数据行按顺序接在后面。</em>',
        '            </div>',

        '            <div class="row"><button data-dbg="resetLayout">复位预留区宽度</button></div>',
        '            <div class="note">宽度、位置、透明度、状态储存在浏览器 localStorage，重启后保留；</div>',
        '          </div>',
        '        </div>',
        '      </div>',

        '    </div>',
        '  </div>',
        '  <div class="divider" data-side="left" hidden>',
        '    <i class="line"></i><i class="grip"></i>',
        '  </div>',
        '  <div class="bubble"></div>',
        '  <div class="toast"></div>',
        '  <div class="sp-tip" data-ref="tip"></div>',
        '  <div class="mini" data-side="left" hidden>',
        `    <button data-act="${ACT.TOGGLE}" title="显示预留区（Alt+Z）">${ICON.show}</button>`,
        `    <button data-act="${ACT.SIDE}" title="切换预留区到另一侧（Alt+X）">${ICON.swap}</button>`,
        '  </div>',
        '</div>'
      ].join('');

      document.body.appendChild(host);
      this.host = host;
      this.root = root;

      const q = (selector) => root.querySelector(selector);
      this.refs = {
        panel: q('.panel'),
        divider: q('.divider'),
        bubble: q('.bubble'),
        mini: q('.mini'),
        toast: q('.toast'),
        tip: q('.sp-tip'),
        panelW: q('[data-ref="panelW"]'),
        hostW: q('[data-ref="hostW"]'),
        viewShow: q('.view-show'),
        viewDebug: q('.view-debug'),
        content: q('[data-ref="content"]'),
        settings: q('[data-ref="settings"]'),
        webopt: q('[data-ref="webopt"]'),
        mergeInput: q('[data-ref="mergeInput"]'),
        optAlpha: q('[data-ref="optAlpha"]'),
        alphaVal: q('[data-ref="alphaVal"]')
      };

      this.bindInteractions();
      this.render(Store.state);
      Show.render();                                     // 先铺展示界面骨架
      Settings.render();                                 // 设置项随面板一起就位
      Settings.renderWeb();                              // 网页优化开关
      Show.autoFill();                                   // 表格渲染较慢时补读几次
      if (this.unsubscribe) this.unsubscribe();
      this.unsubscribe = Store.subscribe((state) => this.render(state));
    },

    /**
     * 事件驱动的补挂：在用户操作 / 尺寸变化 / 标签页切回时检查宿主是否还在，
     * 不在就重新 mount（幂等，不会重复创建）。
     */
    ensureMounted() {
      if (this.hold) return;
      if (!this.mounted) { this.mount(); return; }
      if (this.host && !this.host.isConnected && document.body) {
        this.mounted = false;
        this.host = null;
        this.root = null;
        this.refs = {};
        this.mount();
      }
    },

    /**
     * 收回：摘掉整层 DOM 并置 hold，避免随后一次 apply / ensureMounted 立刻挂回。
     * 只动自己的节点与 html 上的属性，关掉即整页复原。
     */
    unmount() {
      this.hold = true;
      if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
      if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
      this.host = null;
      this.root = null;
      this.refs = {};
      this.mounted = false;
    },

    /* ---------- §7.2 事件绑定：全部挂在 shadow root 上做委托 ---------- */

    bindInteractions() {
      const root = this.root;

      // ① 顶栏 / 迷你条按钮 —— 一个入口分发
      root.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-act]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const action = button.getAttribute('data-act');
        if (action === ACT.SIDE) App.toggleSide();
        else if (action === ACT.TOGGLE) App.toggleEnabled();
        else if (action === ACT.VIEW) App.toggleView();
        else if (action === ACT.REFRESH) Show.refresh();
      });

      // ② 展示页 / 设置页的功能控件：统一交给 §11 的调度器
      root.addEventListener('click', (event) => {
        const node = event.target.closest('[data-sp]');
        if (!node) return;
        event.preventDefault();
        event.stopPropagation();
        ShowUI.onClick(node);
      });

      // ③ 扩展列开关：点标签即切换（标蓝 = 已选）
      root.addEventListener('click', (event) => {
        const tag = event.target.closest('[data-excol]');
        if (!tag) return;
        event.preventDefault();
        event.stopPropagation();
        ShowUI.toggleExtra(tag);
      });

      // ③b 网页优化开关：点标签即切换
      root.addEventListener('click', (event) => {
        const tag = event.target.closest('[data-web]');
        if (!tag) return;
        event.preventDefault();
        event.stopPropagation();
        Settings.toggleWeb(tag.getAttribute('data-web') || '');
      });

      root.addEventListener('input', (event) => {
        const node = event.target;
        if (node.matches('input[data-ref="spSearch"]')) ShowUI.onSearch(node.value);
      });

      // 关键词框：回车即存入词库（写入后变黄）
      root.addEventListener('keydown', (event) => {
        const node = event.target;
        if (!node.matches || !node.matches('input[data-ref="spSearch"]')) return;
        if (event.key !== 'Enter') return;
        event.preventDefault();
        ShowUI.addMark(node.value);
      });

      // ④ 商品卡：点中文名 = 复制，点其它位置 = 勾选 / 取消；悬停出浮窗
      root.addEventListener('click', (event) => {
        if (event.target.closest('[data-sp],[data-excol],[data-web]')) return;
        const card = event.target.closest('[data-card]');
        if (!card) return;
        event.preventDefault();
        ShowUI.onCardClick(card, event);
      });

      root.addEventListener('pointerover', (event) => {
        const card = event.target.closest('[data-card]');
        if (!card || card.contains(event.relatedTarget)) return;
        ShowUI.onCardHover(card);
      });

      root.addEventListener('pointerout', (event) => {
        const card = event.target.closest('[data-card]');
        if (!card || card.contains(event.relatedTarget)) return;
        ShowUI.onCardLeave();
      });

      // 列表一滚动，浮窗的位置就失效了，直接收起来
      root.addEventListener('scroll', () => ShowUI.hideTip(), true);

      // ② 设置界面里的普通按钮
      root.addEventListener('click', (event) => {
        const dbg = event.target.closest('[data-dbg]');
        if (!dbg) return;
        event.preventDefault();
        const action = dbg.getAttribute('data-dbg');
        if (action === 'resetLayout') App.resetHostWidth();
        else if (action === 'merge') {
          const input = View.refs.mergeInput;
          if (input) { input.value = ''; input.click(); }
        }
      });

      // 合并：选完文件就开工
      if (View.refs.mergeInput) {
        View.refs.mergeInput.addEventListener('change', (event) => {
          const files = Array.prototype.slice.call(event.target.files || []);
          if (files.length) Merge.run(files);
        });
      }

      // ③ 透明度滑块：拖动时只写 CSS 变量，松手才落盘
      if (this.refs.optAlpha) {
        this.refs.optAlpha.addEventListener('input', (event) => {
          const pct = Util.clamp(parseInt(event.target.value, 10) || 100,
            CONFIG.UI.ALPHA_MIN, CONFIG.UI.ALPHA_MAX);
          Store.state.alpha = pct / 100;
          StyleLayer.setAlpha(Store.state.alpha);
          View.setAlphaLabel(pct);
        });
        this.refs.optAlpha.addEventListener('change', () => App.savePreferences());
      }

      // ④ 双击分隔线：回到默认宽度
      this.refs.divider.addEventListener('dblclick', (event) => {
        event.preventDefault();
        App.resetHostWidth();
      });

      this.bindPanelInput();
      this.bindDrag();
    },

    /** 顶栏数字：点一下就能输入预留区宽度，回车生效、Esc 取消 */
    bindPanelInput() {
      const input = this.refs.panelW;
      let cancelled = false;

      input.addEventListener('keydown', (event) => {
        event.stopPropagation();               // 别让快捷键和站点快捷键抢键
        if (event.key === 'Enter') {
          event.preventDefault();
          input.blur();                        // 统一走 blur 提交，避免两条提交路径
        } else if (event.key === 'Escape') {
          cancelled = true;
          event.preventDefault();
          input.blur();
        }
      });

      input.addEventListener('focus', () => input.select());

      input.addEventListener('blur', () => {
        if (cancelled) {
          cancelled = false;
          input.value = String(Store.state.reserveW);
          return;
        }
        const digits = String(input.value).replace(/[^\d]/g, '');
        const next = parseInt(digits, 10);
        if (!isFinite(next) || next <= 0) {
          input.value = String(Store.state.reserveW);
          return;
        }
        App.setPanelWidth(next);
        input.value = String(Store.state.reserveW);   // 被夹取时回写真正生效的值
      });
    },

    /**
     * 拖拽：以 pointerdown 那一刻为起点做增量计算，位移 0 的单击不改变宽度。
     * pointermove 用 rAF 合并，一帧最多写一次样式变量；松手补最后一帧。
     */
    bindDrag() {
      const divider = this.refs.divider;
      let pointerId = null;
      let startX = 0;
      let startPanelW = 0;
      let rafId = 0;
      let pendingX = 0;

      const applyTo = (clientX) => {
        const delta = clientX - startX;
        // 左侧面板：往右拖变宽；右侧面板：往左拖变宽
        const raw = Store.state.side === SIDE.RIGHT ? startPanelW - delta : startPanelW + delta;

        // 手动宽度只守两条边：不小于 200（再小就收起）、网页不小于 320
        const realW = Store.state.realW;
        const upper = Math.max(CONFIG.PANEL_FLOOR_W, realW - CONFIG.HOST_FLOOR_W);
        const collapse = raw < CONFIG.PANEL_FLOOR_W;
        let next = Math.round(Util.clamp(raw, 0, upper));

        // 吸附：靠近基准宽度时自动落位
        const snapped = !collapse && Math.abs(next - CONFIG.PANEL_BASE_W) <= CONFIG.SNAP_RADIUS;
        if (snapped) next = CONFIG.PANEL_BASE_W;

        App.previewPanelWidth(next, snapped, collapse);
      };

      const scheduleMove = (clientX) => {
        pendingX = clientX;
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          applyTo(pendingX);
        });
      };

      const flushMove = (clientX) => {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        applyTo(clientX);
      };

      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        pointerId = event.pointerId;
        startX = event.clientX;
        startPanelW = Store.state.reserveW;
        try { divider.setPointerCapture(pointerId); } catch (e) {}

        divider.classList.add('dragging');
        StyleLayer.setDragging(true);
        View.renderDrag(Store.state.hostW, Store.state.reserveW, false);
      };

      const onPointerMove = (event) => {
        if (pointerId === null || event.pointerId !== pointerId) return;
        event.preventDefault();
        scheduleMove(event.clientX);
      };

      const onPointerUp = (event) => {
        if (pointerId === null || event.pointerId !== pointerId) return;
        pointerId = null;
        try { divider.releasePointerCapture(event.pointerId); } catch (e) {}
        flushMove(event.clientX);        // 补上最后一帧，避免松手位置丢失
        divider.classList.remove('dragging');
        StyleLayer.setDragging(false);
        App.commitPanelWidth();
      };

      divider.addEventListener('pointerdown', onPointerDown);
      divider.addEventListener('pointermove', onPointerMove);
      divider.addEventListener('pointerup', onPointerUp);
      divider.addEventListener('pointercancel', onPointerUp);
    },

    /* ---------- §7.3 渲染：只读状态，只写 DOM ---------- */

    render(state) {
      if (!this.mounted) return;
      const { panel, divider, mini, bubble } = this.refs;

      // 面板不显示时（收起 / 窗口窄到没有预留空间），UI 只剩迷你停靠条，
      // 迷你条就是唯一的恢复入口，所以它的显示条件与面板严格互补。
      const showPanel = state.enabled && state.canSplit !== false;
      panel.hidden = !showPanel;
      divider.hidden = !showPanel;
      mini.hidden = showPanel;
      if (!showPanel) bubble.classList.remove('show');

      panel.setAttribute('data-side', state.side);
      divider.setAttribute('data-side', state.side);
      mini.setAttribute('data-side', state.side);

      this.syncPanelInput(state.reserveW);
      this.refs.hostW.textContent = state.hostW;

      // 底色透明度：只写一个 CSS 变量，文字颜色不受影响
      StyleLayer.setAlpha(state.alpha);
      this.syncAlpha(state.alpha);

      // 展示界面 ⇄ 设置界面：互斥，同一时刻只显示一个
      const debug = state.view === 'debug';
      this.refs.viewShow.classList.toggle('on', !debug);
      this.refs.viewDebug.classList.toggle('on', debug);
    },

    /** 拖动过程中的高频更新：只碰必要节点 */
    renderDrag(hostW, reserveW, snapped, collapse) {
      if (!this.mounted) return;
      const dividerX = Store.state.side === SIDE.LEFT ? reserveW : hostW;

      this.refs.divider.classList.toggle('snap', !!snapped || !!collapse);
      this.syncPanelInput(reserveW);
      this.refs.hostW.textContent = hostW;

      const bubble = this.refs.bubble;
      bubble.style.left = dividerX + 'px';
      bubble.textContent = collapse
        ? `松手即收起 · 预留 ${reserveW}`
        : `${snapped ? `已吸附 ${CONFIG.PANEL_BASE_W} · ` : ''}预留 ${reserveW} · 网页 ${hostW}`;
      bubble.classList.add('show');
      bubble.classList.toggle('snap', !!snapped && !collapse);
    },

    hideBubble() {
      if (this.mounted) this.refs.bubble.classList.remove('show');
    },

    /** 顶栏宽度输入框回写；用户正在输入时不打断 */
    syncPanelInput(reserveW) {
      const input = this.refs.panelW;
      if (!input) return;
      if (this.root && this.root.activeElement === input) return;
      const next = String(reserveW);
      if (input.value !== next) input.value = next;
    },

    /** 提示条：一个小气泡，1.8 秒后自己消失（一次性定时器） */
    toast(text) {
      if (!this.mounted) return;
      const node = this.refs.toast;
      if (!node) return;
      node.textContent = text;
      node.classList.add('on');
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => node.classList.remove('on'), 1800);
    },

    /** 设置界面里那行百分比小字 */
    setAlphaLabel(pct) {
      const node = this.refs.alphaVal;
      if (node && node.textContent !== pct + '%') node.textContent = pct + '%';
    },

    /** 滑块回写；正在拖动时不打断 */
    syncAlpha(alpha) {
      const input = this.refs.optAlpha;
      const pct = Math.round((typeof alpha === 'number' ? alpha : 1) * 100);
      if (input && this.root && this.root.activeElement !== input) input.value = String(pct);
      this.setAlphaLabel(pct);
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §8  控制器
   * ═══════════════════════════════════════════════════════════════════════ */

  const App = {
    booted: false,
    wasEnabled: true,      // 离开本页前的开关状态，回来时照原样恢复
    suspended: false,      // 已离开本页（此时 enabled 恒为 false，不能当成「用户收起」写进存档）

    /* ---------- §8.1 持久化 ---------- */

    /** 从 localStorage 恢复偏好（side / panelW / enabled / alpha） */
    loadPreferences() {
      const saved = Util.readJSON(CONFIG.STORAGE_KEY);
      if (!saved) return;

      if (saved.side === SIDE.LEFT || saved.side === SIDE.RIGHT) {
        Store.state.side = saved.side;
      }
      if (typeof saved.enabled === 'boolean') {
        Store.state.enabled = saved.enabled;
      }
      if (typeof saved.panelW === 'number' && isFinite(saved.panelW)) {
        Store.state.userPanelW = saved.panelW;
      }
      // 透明度夹到 [下限, 1]，防止手改 localStorage 后出现 0（面板彻底看不见、找不回来）
      if (typeof saved.alpha === 'number' && isFinite(saved.alpha)) {
        Store.state.alpha = Util.clampAlpha(saved.alpha);
      }
    },

    savePreferences() {
      Util.writeJSON(CONFIG.STORAGE_KEY, {
        side: Store.state.side,
        panelW: Store.state.userPanelW,
        // 离开本页期间 enabled 被强制置 false，那不是用户的选择
        enabled: this.suspended ? this.wasEnabled : Store.state.enabled,
        alpha: Store.state.alpha
      });
    },

    /* ---------- §8.2 布局应用 ---------- */

    /** 重新测量真实宽度并整体应用 */
    apply() {
      const state = Store.state;
      const realW = state.realW || CONFIG.BASE_VIEW_W;

      // 顺手确认 UI 还在（站点整体重绘可能把我们的层删掉）。
      // 只是一次 isConnected 判断，不监听、不轮询。
      View.ensureMounted();

      const layout = Layout.compute(realW, { userPanelW: state.userPanelW });
      // 手动宽度窄于下限时不允许「半开」：一律按收起处理，宽度整页还原
      const reserveW = layout.canSplit ? layout.reserveW : 0;
      const hostW = Math.round(realW - reserveW);

      const gapLeft = (state.enabled && state.side === SIDE.LEFT) ? reserveW : 0;
      const gapRight = (state.enabled && state.side === SIDE.RIGHT) ? reserveW : 0;

      StyleLayer.setEnabled(state.enabled);
      StyleLayer.setMetrics(hostW, reserveW, gapLeft, gapRight);

      // 唯一的落点：写回状态，订阅者（视图）自动重绘。
      // 关闭分区时宿主就是整个视口 —— 让 state 与实际布局保持一致。
      Store.patch({
        hostW: state.enabled ? hostW : layout.realW,
        reserveW: state.enabled ? reserveW : 0,
        canSplit: layout.canSplit
      });

      Util.log(`网页 ${hostW}px | 预留 ${reserveW}px | 真实 ${realW}px | 侧 ${state.side} | ${state.enabled ? '开' : '关'}`);
    },

    /** 拖动中的预览：改状态 + 变量，不落盘、不重算布局 */
    previewPanelWidth(panelW, snapped, collapse) {
      const realW = Store.state.realW;
      const reserveW = Math.max(0, Math.min(panelW, realW));
      Store.state.hostW = Math.max(0, realW - reserveW);
      Store.state.reserveW = reserveW;
      StyleLayer.setMetrics(Store.state.hostW, reserveW,
        Store.state.side === SIDE.LEFT ? reserveW : 0,
        Store.state.side === SIDE.RIGHT ? reserveW : 0);
      View.renderDrag(Store.state.hostW, reserveW, snapped, collapse);
    },

    /** 松手：记住位置并通知页面重排；拖到下限以下就直接收起 */
    commitPanelWidth() {
      View.hideBubble();
      if (View.refs.divider) View.refs.divider.classList.remove('snap');

      if (Store.state.reserveW < CONFIG.PANEL_FLOOR_W) {
        Store.state.userPanelW = null;
        Store.patch({ enabled: false });
        this.savePreferences();
        this.apply();
        this.notifyResize();
        View.toast(`预留区低于 ${CONFIG.PANEL_FLOOR_W}px，已收起（Alt+Z 恢复）`);
        return;
      }

      Store.state.userPanelW = Store.state.reserveW;
      this.savePreferences();
      View.render(Store.state);
      this.notifyResize();
    },

    /** 双击 / 按钮复位：回到公式值，并清掉手动记忆 */
    resetHostWidth() {
      Store.state.userPanelW = null;
      this.savePreferences();
      this.apply();
      View.hideBubble();
      if (View.refs.divider) View.refs.divider.classList.remove('snap');
      this.notifyResize();
      View.toast(`预留区已复位到 ${Store.state.reserveW}px（网页 ${Store.state.hostW}px）`);
    },

    /** 直接指定预留区宽度（顶栏那个数字就是入口）：只守 200 下限与网页 320 下限 */
    setPanelWidth(next) {
      const wanted = Math.round(next);
      const realW = Store.state.realW || CONFIG.BASE_VIEW_W;
      const upper = Math.max(CONFIG.PANEL_FLOOR_W, Math.round(realW - CONFIG.HOST_FLOOR_W));

      View.hideBubble();
      if (View.refs.divider) View.refs.divider.classList.remove('snap');

      if (wanted < CONFIG.PANEL_FLOOR_W) {
        Store.state.userPanelW = null;
        Store.patch({ enabled: false });
        this.savePreferences();
        this.apply();
        this.notifyResize();
        View.toast(`小于 ${CONFIG.PANEL_FLOOR_W}px，预留区已收起（Alt+Z 恢复）`);
        return;
      }

      const clamped = Util.clamp(wanted, CONFIG.PANEL_FLOOR_W, upper);
      Store.state.userPanelW = clamped;
      this.savePreferences();
      this.apply();
      this.notifyResize();

      if (clamped !== wanted) {
        View.toast(`预留区可用范围 ${CONFIG.PANEL_FLOOR_W}–${upper}px，已改用 ${clamped}px`);
      }
    },

    /**
     * 页面里的图表 / 表格一般只监听 window resize。
     * 布局改了但窗口没变，所以主动派发一次 resize（下一帧，避免打断 pointerup）。
     */
    notifyResize() {
      setTimeout(() => {
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
      }, 0);
    },

    /* ---------- §8.3 用户操作 ---------- */

    toggleEnabled() {
      Store.patch({ enabled: !Store.state.enabled });
      this.savePreferences();          // 收起 / 展开要记住，下次打开还是这个样子
      this.apply();
      setTimeout(() => this.recalibrate(), 60);   // 滚动条出现/消失会改变可用宽度
    },

    toggleSide() {
      const next = Store.state.side === SIDE.LEFT ? SIDE.RIGHT : SIDE.LEFT;
      Store.patch({ side: next });
      this.savePreferences();
      this.apply();
    },

    /** 展示界面 ⇄ 设置界面 */
    toggleView() {
      Store.patch({ view: Store.state.view === 'debug' ? 'show' : 'debug' });
    },

    /* ---------- §8.4 尺寸校准 ---------- */

    /** 只在真实视窗变化时重算（页面自己派发的 resize 会被数值比较挡掉）；带重入保护 */
    recalibrate() {
      if (this.recalibrating) return;
      this.recalibrating = true;
      try {
        const next = measureLayoutWidth();
        if (Math.abs(next - Store.state.realW) < 1) return;
        Store.state.realW = next;
        this.apply();
      } finally {
        this.recalibrating = false;
      }
    },

    /**
     * 有限次校准：加载后 4 秒内跑 5 次一次性定时器，然后停止。
     * 首屏可能还没有纵向滚动条，可用宽度会偏大，分层采样覆盖这段过渡期。
     */
    scheduleCalibration() {
      [200, 600, 1200, 2400, 4000].forEach((ms) => setTimeout(() => this.recalibrate(), ms));
    },

    /* ---------- §8.5 全局事件 ---------- */

    bindGlobalEvents() {
      const onResize = Util.debounce(() => this.recalibrate(), 120);
      window.addEventListener('resize', onResize, { passive: true });

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.recalibrate(), { once: true });
      } else {
        this.recalibrate();
      }

      if (document.readyState === 'complete') {
        setTimeout(() => this.recalibrate(), 300);
      } else {
        window.addEventListener('load', () => this.recalibrate(), { once: true });
      }

      this.scheduleCalibration();

      // 切回标签页：校准一次 + 补挂 UI。事件驱动，不是轮询。
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        this.recalibrate();
        View.ensureMounted();
      });

      window.addEventListener('keydown', (event) => {
        if (!event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === 'z') { event.preventDefault(); this.toggleEnabled(); }
        else if (key === 'x') { event.preventDefault(); this.toggleSide(); }
      }, true);
    },

    /* ---------- §8.6 区域收回 / 恢复 ---------- */

    /**
     * 站点是前端路由，跨页不刷新文档，面板会一直留在屏幕上。
     * 监听 URL 条目变化（优先 navigation API，不支持则拦 pushState + popstate），
     * 仅在「进入 / 离开 /product」切换时回调。
     */
    watchRoute() {
      let last = Gate.matches();
      const fire = () => {
        const next = Gate.matches();
        if (next === last) return;
        last = next;
        if (next) this.resume();
        else this.retract();
      };

      const nav = window.navigation;
      if (nav && nav.addEventListener) {
        nav.addEventListener('currententrychange', fire);   // 现代 Chrome / Edge
      } else {
        window.addEventListener('popstate', fire);
        ['pushState', 'replaceState'].forEach((name) => {
          const raw = history[name];
          history[name] = function () { const out = raw.apply(this, arguments); fire(); return out; };
        });
      }
    },

    /** 离开本页 → 收回：关掉分区开关（宽度与伪装同一帧回到真实值）→ 卸掉 UI */
    retract() {
      this.wasEnabled = Store.state.enabled;
      this.suspended = true;
      if (Store.state.enabled) { Store.patch({ enabled: false }); this.apply(); }
      View.unmount();
      Util.log('已离开 /product，已收回（宽度恢复，UI 摘除）');
    },

    /** 回到本页 → 恢复收回前的状态（用户自己按 Alt+Z 收起的，不替他打开） */
    resume() {
      View.mount();
      this.suspended = false;
      if (this.wasEnabled === false) { View.render(Store.state); return; }
      if (!Store.state.enabled) { Store.patch({ enabled: true }); this.apply(); }
      Show.refresh();
      Util.log('已回到 /product，已恢复');
    },

    /* ---------- §8.7 启动 ---------- */

    init() {
      if (this.booted) return;
      this.booted = true;

      this.loadPreferences();

      // ① 最早时刻：先定一个可用的尺寸，再装 window 级伪装（不需要 DOM）
      const bootWidth = NativeProbe.innerWidth();
      Store.state.realW = bootWidth > 400 ? bootWidth : CONFIG.BASE_VIEW_W;
      const bootLayout = Layout.compute(Store.state.realW, { userPanelW: Store.state.userPanelW });
      Store.state.hostW = bootLayout.hostW;
      Store.state.reserveW = bootLayout.reserveW;

      Spoofer.installWindow();

      // ② <html> 出现：立刻装样式（避免首屏按全宽排版再跳），补 document 级伪装
      whenDocumentElement(() => {
        StyleLayer.install();
        Spoofer.installDocument();
        Store.state.realW = measureLayoutWidth();
        this.apply();
      });

      // ③ <body> 出现：补 body 级伪装 + 挂 UI（mount 内部已铺面板内容）
      whenBody(() => {
        Spoofer.installBody();
        View.mount();
      });

      this.bindGlobalEvents();
      this.watchRoute();

      // ④ 控制台调试接口
      window.KDP_SPLIT = {
        get state() { return Object.assign({}, Store.state, { config: CONFIG }); },
        set(options) {
          const opts = options || {};
          if (opts.side === SIDE.LEFT || opts.side === SIDE.RIGHT) Store.patch({ side: opts.side });
          if (typeof opts.panelW === 'number') {
            Store.state.userPanelW = Math.max(CONFIG.PANEL_FLOOR_W, Math.round(opts.panelW));
          }
          if (typeof opts.alpha === 'number') {
            Store.state.alpha = Util.clampAlpha(opts.alpha > 1 ? opts.alpha / 100 : opts.alpha);
          }
          App.savePreferences();
          App.apply();
          if (View.mounted) View.render(Store.state);
        },
        reset() {
          Util.removeKey(CONFIG.STORAGE_KEY);
          Store.patch({ side: CONFIG.DEFAULT_SIDE, enabled: true, view: 'show' });
          Store.state.userPanelW = null;
          Store.state.alpha = CONFIG.UI.ALPHA;
          App.apply();
          App.savePreferences();
        },

        /* 调试用：看导出的列计划与文件名，不落盘 */
        get exportPlan() {
          const sheet = Sheet.build(Data.items);
          return { headers: sheet.headers, widths: sheet.widths, file: Xlsx.filename(), rows: sheet.rows.length };
        },

        /** 控制台入口：KDP_SPLIT.merge([File, File]) 合并多份导出 */
        merge(files) { return Merge.run(files); },
        remeasure() { App.recalibrate(); return Store.state.realW; },
        refresh() { Show.refresh(); }
      };
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §9  启动
   *  两个 DOM 就绪钩子放在最底层，供上层各处复用。
   * ═══════════════════════════════════════════════════════════════════════ */

  /**
   * 等 <html> 出现：已存在则同步回调，否则用 MutationObserver + rAF 兜底，
   * 就绪后立刻断开观察器。
   */
  function whenDocumentElement(callback) {
    if (document.documentElement) { callback(document.documentElement); return; }

    let fired = false;
    const fire = (element) => {
      if (fired) return;
      fired = true;
      try { observer.disconnect(); } catch (e) {}
      callback(element);
    };

    const observer = new MutationObserver(() => {
      if (document.documentElement) fire(document.documentElement);
    });
    try { observer.observe(document, { childList: true, subtree: true }); } catch (e) {}

    let tries = 0;
    (function tick() {
      if (fired) return;
      if (document.documentElement) { fire(document.documentElement); return; }
      if (++tries > 1200) return;          // rAF 兜底，约 20 秒后放弃
      requestAnimationFrame(tick);
    })();
  }

  /** 等 <body> 出现；同样一次性，就绪即断开 */
  function whenBody(callback) {
    if (document.body) { callback(document.body); return; }

    let fired = false;
    const fire = (body) => {
      if (fired) return;
      fired = true;
      try { observer.disconnect(); } catch (e) {}
      callback(body);
    };

    const observer = new MutationObserver(() => {
      if (document.body) fire(document.body);
    });
    try { observer.observe(document.documentElement || document, { childList: true, subtree: true }); } catch (e) {}

    document.addEventListener('DOMContentLoaded', () => {
      if (document.body) fire(document.body);
    }, { once: true });
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * §10  业务层 · 商品数据导出（Excel）
   *
   *  分层（自上而下，下层不反向调用）：
   *    §10.1 常量      列计划 / 版式参数 / 缓存键
   *    §10.2 格式化    纯函数：金额、比例、数字
   *    §10.3 采集      只读页面缓存：表格实例行 / 图片 / 页面状态 / 类目字典
   *    §10.4 翻译      批量调站点翻译接口，带本地缓存
   *    §10.5 组装      采集结果 → 列终值
   *    §10.6 ZIP       无依赖的 store 模式 ZIP 打包
   *    §10.7 XLSX      sheet / styles / workbook 三件套 + 下载
   * ═══════════════════════════════════════════════════════════════════════ */

  /* ---------- §10.1 常量 ---------- */

  const EX = {
    TRANS_URL: 'https://www.kalodata.com/v1/translation/translate',
    TRANS_CONCURRENCY: 5,
    TRANS_TIMEOUT: 8000,
    TRANS_CACHE_KEY: 'kdp-trans-cache',
    TRANS_CACHE_MAX: 1500,
    CATE_CACHE_KEY: 'kdp-cate-map',
    STATE_DATE_KEY: 'pageListCategory-dateRange',
    STATE_PAGE_KEY: 'pageList-product',
    LANG_KEY: 'h5_language',
    CUR_KEY: 'h5_currency',
    IMAGE_TPL: 'https://img.kalowave.cn/tiktok.product/{id}/cover.png',
    FILE_PREFIX: 'kalodata_ranking_',
    PLACEHOLDER: '#',
    ROW_HEIGHT: 75,           // 内容行：75 磅，容纳多行标题
    HEADER_HEIGHT: 20,        // 表头：20 磅，单行
    FILL_WAIT: [600, 1500, 3200, 6000, 10000, 15000],  // 表格渲染较慢时的有限次补读（一次性定时器）

    // 店铺标记文案（与 Python 抓取脚本同口径）
    DELIVERY_CN: { local: '本土店', global: '跨境店' }
  };

  /**
   * 列计划：表头 / 取值键 / 值类型。
   * 列宽不在列定义里，统一由 COL_WIDTH 决定；值类型决定数字格式与对齐。
   */
  const COLS = [
    { key: 'dateRange', header: '日期范围', kind: 'daterange' },
    { key: 'title', header: '商品名称', kind: 'text' },
    { key: 'translation', header: '商品翻译', kind: 'text' },
    { key: 'image', header: '商品图片', kind: 'image' },
    { key: 'category', header: '类目', kind: 'textc' },
    { key: 'price', header: '价格', kind: 'money' },
    { key: 'avgPrice', header: '平均销售价', kind: 'money' },
    { key: 'sales', header: '销量', kind: 'int' },
    { key: 'launch', header: '上架时间', kind: 'date' },
    { key: 'rating', header: '商品评分', kind: 'rating' },
    { key: 'gmv', header: '成交金额', kind: 'money_big' },
    { key: 'gmvGrowth', header: '成交金额增长率', kind: 'percent' },
    { key: 'shipping', header: '运费', kind: 'money' },
    { key: 'commission', header: '佣金比例', kind: 'percent' },
    { key: 'liveGmv', header: '直播成交', kind: 'money_big' },
    { key: 'videoGmv', header: '视频成交', kind: 'money_big' },
    { key: 'cardGmv', header: '商品卡成交', kind: 'money_big' },
    { key: 'creatorNum', header: '达人数量', kind: 'int' },
    { key: 'creatorRate', header: '达人出单率', kind: 'percent' },
    { key: 'imageUrl', header: '图片链接', kind: 'url' },
    { key: 'detailUrl', header: 'Kalodata详情页链接', kind: 'url' },
    { key: 'tiktokUrl', header: 'TikTok链接', kind: 'url' }
  ];

  /**
   * 扩展列：默认不导出，由设置界面逐项打开后追加到基础列之后。
   */
  const EXTRA_COLS = [
    { key: 'skuMax', header: '最高SKU价', kind: 'money', on: false },
    { key: 'skuMin', header: '最低SKU价', kind: 'money', on: false },
    { key: 'gmvA', header: 'GMV1', kind: 'money_big', on: false },
    { key: 'gmvB', header: 'GMV2', kind: 'money_big', on: false },
    { key: 'trend', header: '每日成交金额(¥)', kind: 'nowrap', on: false },
    { key: 'shopType', header: '店铺类型', kind: 'center', on: false },
    { key: 'fullService', header: '全托管', kind: 'center', on: false },
    { key: 'overseas', header: '海外仓', kind: 'center', on: false },
    { key: 'tokopedia', header: 'Tokopedia', kind: 'center', on: false }
  ];

  /**
   * 前置列：搜索词 / 国家 / 序号 —— 勾上就插在整张表最前面（顺序同这个数组）。
   * 搜索词是页面顶部那个搜索框里的词，为空时这一列直接不出现。
   */
  const META_COLS = [
    { key: 'query', header: '搜索词', kind: 'text' },
    { key: 'country', header: '国家', kind: 'center' },
    { key: 'rank', header: '序号', kind: 'center' }
  ];

  /**
   * 固定列宽（字符），不提供界面调整；未列出的列一律 9。
   */
  const COL_WIDTH = {
    title: 28,
    translation: 28,
    imageUrl: 20,
    detailUrl: 20,
    tiktokUrl: 20,
    trend: 20,
    gmvGrowth: 12,
    image: 12
  };
  const COL_WIDTH_DEFAULT = 9;

  /* 值类型 → cellXfs 下标（下标含义见 §10.7 stylesXml） */
  const XF = { header: 1, text: 2, center: 3, nowrap: 4, url: 5, percent: 6 };
  const XF_OF = {
    text: 'text', textc: 'center', daterange: 'center',
    money: 'center', money_big: 'center', int: 'center',
    rating: 'center', date: 'nowrap', url: 'url',
    percent: 'percent', image: 'center'
  };

  /**
   * 网页优化开关，逐项独立、即时生效，关掉即透传。
   *   thumbBg     缩略图用 background-image 按显示尺寸解码
   *   blockAds    拦截第三方广告 / 监控像素
   *   blockTrack  拦截站点自家埋点上报
   *   liveSync    列表接口返回时自动重读面板
   */
  const WebOpt = {
    applied: false,
    data: { thumbBg: true, blockAds: true, blockTrack: false, liveSync: true },
    ITEMS: [
      { key: 'thumbBg', label: '缩略图省内存', hint: '缩略图按显示尺寸解码，减少图片内存' },
      { key: 'blockAds', label: '拦广告像素', hint: '掐掉 twitter / bing / 百度 / 热图等第三方像素' },
      { key: 'blockTrack', label: '拦站点埋点', hint: '屏蔽自家 das. 上报与 /api/log' },
      { key: 'liveSync', label: '跟随翻页/筛选', hint: '页面数据一变就自动重读，不用点「重新读取」' }
    ],

    /* 第三方广告 / 监控域名（后缀匹配，含子域）；只含纯遥测类，不碰鉴权与风控接口 */
    AD_HOSTS: [
      'analytics.twitter.com',      // 广告转化像素
      'static.ads-twitter.com',     // 像素的脚本源
      'bat.bing.com',               // 微软 UET
      'hm.baidu.com',               // 百度统计
      'sentry.io',                  // 前端错误上报
      'clarity.ms'                  // 微软热图（脚本与上报同域）
    ],
    TRACK_HOSTS: ['das.kalodata.com'],   // 站点自家统计

    load() {
      const saved = Util.readJSON(CONFIG.WEB_CFG_KEY);
      if (saved) {
        Object.keys(this.data).forEach((key) => {
          if (typeof saved[key] === 'boolean') this.data[key] = saved[key];
        });
      }
      return this.data;
    },

    save() {
      Util.writeJSON(CONFIG.WEB_CFG_KEY, this.data);
    },

    isOn(key) {
      return !!this.data[key];
    },

    set(key, on) {
      if (!(key in this.data)) return;
      this.data[key] = !!on;
      this.save();
    },

    /**
     * 判定 URL 是否命中拦截名单，运行时读开关。
     * 每次 src / setAttribute 赋值都会调用，先做字符串预筛再 new URL（后者开销最大）。
     */
    hit(url) {
      if (!this.data.blockAds && !this.data.blockTrack) return 0;
      const s = String(url);
      if (s.length < 12 || s.length > 4096) return 0;
      if (!/adsct|twitter|bat\.bing|baidu|sentry|clarity|das\.kalodata|\/api\/log/i.test(s)) return 0;

      let u;
      try { u = new URL(s, location.href); } catch (e) { return 0; }
      const host = u.hostname;
      const path = u.pathname;

      if (this.data.blockAds) {
        // t.co 是推特短链域名，只掐它的像素路径，别误伤正常短链
        if (host === 't.co') {
          if (path.indexOf('/i/adsct') !== -1) return 1;
        } else if (this.AD_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
          return 1;
        }
      }
      if (this.data.blockTrack) {
        if (this.TRACK_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return 1;
        if (host === 'www.kalodata.com' && path === '/api/log') return 1;
      }
      return 0;
    },

    /**
     * 安装拦截器，只装一次；之后按开关实时判定，关闭即透传。
     * 覆盖 fetch / XHR / sendBeacon / Image.src / script·iframe·link 的 src·href / 动态插入标签。
     */
    applyNetwork() {
      if (this.applied) return;
      this.applied = true;
      const self = this;
      const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

      const rawFetch = window.fetch;
      if (typeof rawFetch === 'function') {
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (self.hit(url)) {
            return Promise.resolve(new Response(null, { status: 204, statusText: 'No Content' }));
          }
          return rawFetch.call(this, input, init);
        };
      }

      /*
       * XHR 两处拦：
       *   1) open() 命中即把 URL 换成 about:blank，请求不会发出；
       *      改 URL 而非只拦 send，可避免站点 SDK 重写 send 后绕过。
       *   2) send() 再 abort() 兜底。
       */
      const rawOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        if (self.hit(url)) {
          this.__kdpBlocked = true;
          const rest = Array.prototype.slice.call(arguments, 2);   // async / user / password 要原样带上
          return rawOpen.apply(this, [method, 'about:blank'].concat(rest));
        }
        return rawOpen.apply(this, arguments);
      };

      const rawSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        if (this.__kdpBlocked) { try { this.abort(); } catch (e) { /* 已拦截 */ } return; }
        return rawSend.apply(this, arguments);
      };

      if (navigator.sendBeacon) {
        const rawBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) {
          if (self.hit(url)) return true;
          return rawBeacon(url, data);
        };
      }

      /*
       * 像素图：new Image().src = '...' 不走上面任何一路，
       * 改写 HTMLImageElement.prototype.src 的 setter，命中就换成 1 字节透明 gif。
       */
      const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (srcDesc && srcDesc.set && srcDesc.get) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          configurable: true,
          enumerable: srcDesc.enumerable,
          get: srcDesc.get,
          set(value) {
            return srcDesc.set.call(this, self.hit(value) ? BLANK : value);
          }
        });
      }

      /*
       * script / iframe / link 的 src·href 在赋值那一刻吞掉（保持空值），
       * 元素挂进文档时就不会产生请求；命中后直接 return，不写入属性。
       */
      const killSetter = (proto, prop, readSrc) => {
        const d = Object.getOwnPropertyDescriptor(proto, prop);
        if (!d || !d.set || !d.get) return;
        Object.defineProperty(proto, prop, {
          configurable: true,
          enumerable: d.enumerable,
          get: d.get,
          set(value) { if (self.hit(readSrc(value))) return; return d.set.call(this, value); }
        });
      };
      killSetter(HTMLScriptElement.prototype, 'src', (v) => v);
      killSetter(HTMLIFrameElement.prototype, 'src', (v) => v);
      killSetter(HTMLLinkElement.prototype, 'href', (v) => v);

      /*
       * setAttribute('src'|'href') 同样处理：
       * IMG 换成透明 gif，SCRIPT / IFRAME / LINK 直接不写入；不动 a[href]，避免误伤跳转。
       */
      const rawSetAttr = Element.prototype.setAttribute;
      const ATTR_TAGS = { SCRIPT: 1, IFRAME: 1, LINK: 1 };
      Element.prototype.setAttribute = function (name, value) {
        if (name === 'src' || name === 'href') {
          if (this.tagName === 'IMG' && name === 'src' && self.hit(value)) value = BLANK;
          else if (ATTR_TAGS[this.tagName] && self.hit(value)) return;
        }
        return rawSetAttr.call(this, name, value);
      };

      /*
       * 补扫：解析器创建的标签（innerHTML / HTML 解析）不走 setter，需要在插入后移除。
       * 只查 script / iframe / link 三种标签；观察 document 而非 documentElement，
       * 因为 document-start 时 <html> 可能尚未创建。
       */
      const killIn = (node) => {
        if (!node.querySelectorAll) return;
        node.querySelectorAll('script[src],iframe[src],link[href]').forEach((el) => {
          if (self.hit(el.src || el.href || '')) el.remove();
        });
      };
      const sweep = (node) => {
        if (!node || node.nodeType !== 1) return;
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'IFRAME' || tag === 'LINK') {
          if (self.hit(node.src || node.href || '')) { node.remove(); return true; }
        }
        if (tag !== 'IMG' && node.firstElementChild) killIn(node);
        return false;
      };
      // 先补扫文档里已存在的标签
      killIn(document);
      const mo = new MutationObserver((muts) => {
        // 两个开关都关时不再扫描新增节点，避免页面每次重渲染都做无谓的子树查询
        if (!self.data.blockAds && !self.data.blockTrack) return;
        for (let i = 0; i < muts.length; i++) {
          const added = muts[i].addedNodes;
          for (let j = 0; j < added.length; j++) sweep(added[j]);
        }
      });
      mo.observe(document, { childList: true, subtree: true });
    }
  };

  /* ---------- §9.4 被动跟随：接口响应即通知 ---------- */

  /**
   * 列表跟随：接口响应即通知。
   *   POST /product/queryList     翻页 / 改筛选 / 改排序
   *   POST /product/searchList    顶部关键词搜索
   * 响应体的 data 是当前页原始记录，请求体带 pageNo / pageSize。
   * XHR 在 open() 里按 URL 挂一次性 load 监听，send() 里记录请求体；
   * fetch 在响应后读 clone()。
   */
  const Live = {
    installed: false,
    sig: '',      // 上一批数据的指纹（id 序列），同一批不重复重绘
    timer: 0,

    install() {
      if (this.installed) return;
      this.installed = true;

      const LIST_API = /\/product\/(queryList|searchList)(\?|$|\/)/;

      const rawOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          if (LIST_API.test(String(url))) {
            this.__kdpList = true;
            this.addEventListener('load', () => Live.onXhr(this), { once: true });
          }
        } catch (e) { /* 钩子出问题也不能影响页面自己的请求 */ }
        return rawOpen.apply(this, arguments);
      };

      // 请求体里才有 pageNo / pageSize：在 send 里抄一份给 onXhr 用
      const rawSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (body) {
        if (this.__kdpList) {
          try { this.__kdpPage = typeof body === 'string' ? JSON.parse(body) : null; } catch (e) { this.__kdpPage = null; }
        }
        return rawSend.apply(this, arguments);
      };

      const rawFetch = window.fetch;
      if (typeof rawFetch === 'function') {
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          const task = rawFetch.call(this, input, init);
          if (LIST_API.test(String(url))) {
            task.then((res) => {
              try {
                res.clone().json().then((json) => Live.onJson(json)).catch(() => {});
              } catch (e) { /* 响应体已被站点消费 */ }
            }).catch(() => {});
          }
          return task;
        };
      }
    },

    /** id 序列指纹：翻页 / 换筛选 / 改排序都会变 */
    sigOf(rows) {
      const ids = [];
      for (let i = 0; i < rows.length; i += 1) ids.push(rows[i] && rows[i].id);
      return rows.length + '|' + ids.join(',');
    },

    onXhr(xhr) {
      if (!xhr || xhr.status < 200 || xhr.status >= 300) return;
      let json = null;
      try {
        json = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
      } catch (e) { return; }
      // 搜索接口的请求体里带着关键词：记下来给「搜索词」列兜底
      if (xhr.__kdpPage && typeof xhr.__kdpPage.query === 'string') {
        Data.lastQuery = xhr.__kdpPage.query.trim();
      }
      this.onJson(json, this.pageBase(xhr.__kdpPage));
    },

    /** 这一页第一条的全局序号：(pageNo-1) × pageSize */
    pageBase(page) {
      if (!page || !page.pageNo || !page.pageSize) return 0;
      return (page.pageNo - 1) * page.pageSize;
    },

    onJson(json, base) {
      if (!WebOpt.isOn('liveSync')) return;
      const rows = json && json.data;
      if (!Array.isArray(rows)) return;
      // 搜出来是空集也要跟着清空面板；但首屏还没读到时不要抢
      if (!rows.length && !Data.items.length) return;

      const sig = this.sigOf(rows);
      if (sig === this.sig) return;
      this.sig = sig;

      // 一次性定时器：同一瞬间的多次响应（列表 + 计数）合成一次重绘
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = 0;
        this.apply(rows, base || 0);
      }, 60);
    },

    apply(rows, base) {
      if (!WebOpt.isOn('liveSync') || !View.mounted) return;

      // 首屏响应可能早于顶部国家选择器挂载：读不到国家就先不接管，
      // 交给 DOM 读取路径，避免导出链接里的 region 变成占位符。
      if (!Data.items.length && !Data.readState().country) return;

      Data.adopt(rows, base);
      ListView.render();
      Sync.bind();
      Show.translate();
      Sync.schedule();
    },

    /** 手动「重新读取」之后对齐指纹，免得下一次响应把同一页再重绘一遍 */
    sync() {
      this.sig = this.sigOf(Data.items);
    }
  };

  /**
   * 导出偏好：只留扩展列开关。
   * 列宽 / 行高 / 对齐一律固定，界面不再提供调整入口。
   */
  const ExCfg = {
    data: { extra: {} },

    load() {
      const saved = Util.readJSON(CONFIG.EXPORT_CFG_KEY);
      if (saved && saved.extra && typeof saved.extra === 'object') {
        Object.keys(saved.extra).forEach((key) => { this.data.extra[key] = !!saved.extra[key]; });
      }
      // 前置三列默认打开
      META_COLS.forEach((col) => {
        if (!(col.key in this.data.extra)) this.data.extra[col.key] = true;
      });
      return this.data;
    },

    save() {
      Util.writeJSON(CONFIG.EXPORT_CFG_KEY, { extra: this.data.extra });
    },

    isOn(key) {
      return !!this.data.extra[key];
    },

    setExtra(key, on) {
      this.data.extra[key] = !!on;
      this.save();
    },

    /** 设置页可切换的列：前置列 + 扩展列 */
    toggleCols() {
      return META_COLS.concat(EXTRA_COLS);
    },

    /** 本次导出的列计划：前置列 + 基础列 + 已打开的扩展列 */
    cols() {
      const lead = META_COLS.filter((col) => {
        if (!this.isOn(col.key)) return false;
        // 搜索词没有就不出这一列
        return col.key !== 'query' || !!Data.searchText();
      });
      const extras = EXTRA_COLS.filter((col) => this.isOn(col.key));
      return lead.concat(COLS, extras);
    },

    /** 列宽：查固定表，查不到就是 9 字符 */
    widthOf(col) {
      return COL_WIDTH[col.key] || COL_WIDTH_DEFAULT;
    }
  };

  /* ---------- §10.2 格式化（纯函数） ---------- */

  const Fmt = {
    /** 文本 → 数字，认不出来返回 null */
    toNumber(value) {
      if (value == null || value === '') return null;
      if (typeof value === 'number') return isFinite(value) ? value : null;
      if (typeof value !== 'string') return null;
      const text = value.replace(/[¥￥,\s]/g, '');
      if (!text) return null;
      const num = parseFloat(text);
      return isFinite(num) ? num : null;
    },

    /**
     * 金额 → 数字：去符号与千分位，万 ×1e4、亿 ×1e8，保留两位小数。
     */
    amount(value) {
      if (value == null || value === '') return null;
      if (typeof value === 'number') return Math.round(value * 100) / 100;
      let text = String(value).replace(/[¥￥,\s]/g, '');
      if (!text) return null;
      let factor = 1;
      if (text.slice(-1) === '万') { factor = 1e4; text = text.slice(0, -1); }
      else if (text.slice(-1) === '亿') { factor = 1e8; text = text.slice(0, -1); }
      const num = parseFloat(text);
      if (!isFinite(num)) return null;
      return Math.round(num * factor * 100) / 100;
    },

    /**
     * 比例 → 小数：数字直接当小数；带 % 的除以 100；
     * 不带 % 的字符串按「百分数写法」处理（'3' 视为 3%）。
     */
    percent(value) {
      if (value == null || value === '') return null;
      if (typeof value === 'number') return isFinite(value) ? value : null;
      const text = String(value).trim();
      if (!text) return null;
      const num = parseFloat(text.replace('%', ''));
      if (!isFinite(num)) return null;
      return num / 100;
    },

    /** 整数列：取整，失败退化成金额换算 */
    intOf(value) {
      if (value == null || value === '') return null;
      const num = parseInt(value, 10);
      if (isFinite(num)) return num;
      return this.amount(value);
    },

    /** 文本列：空值统一占位符 */
    text(value) {
      const str = String(value == null ? '' : value).trim();
      return str || EX.PLACEHOLDER;
    },

    /** 标价：上下限相同给单个数字，不同给 '12.7~115.42' 文本 */
    priceRange(low, high) {
      const strip = (v) => String(v == null ? '' : v).replace(/[¥￥,\s]/g, '');
      const a = strip(low);
      const b = strip(high);
      if (!a && !b) return EX.PLACEHOLDER;
      if (!a || !b) return a || b;
      if (a === b) {
        const num = parseFloat(a);
        return isFinite(num) ? num : a;
      }
      return a + '~' + b;
    },

    /** 下一帧（类目筛选器展开后，选项在下一次绘制前就已挂载） */
    nextFrame() {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
  };

  /* ---------- §10.3 采集（只读页面缓存） ---------- */

  const Data = {
    state: { country: '', start: '', end: '', language: 'zh-CN', currency: 'CNY' },
    items: [],
    images: {},
    cateMap: {},
    lastQuery: '',          // 最近一次搜索接口请求里的关键词（输入框读不到时兜底）
    rev: 0,                 // 每次重读自增，依赖行/卡片的缓存靠它失效

    /** 一次性读完：页面状态 → 行数据 → 图片 → 类目字典 */
    read() {
      this.images = this.readImages();
      this.cateMap = this.readCateMap();
      this.state = this.readState();
      this.items = this.build(this.readTable());
      this.rev += 1;
      return this.items;
    },

    /**
     * 直接使用接口返回的原始行，不读 DOM。
     * rows 为该页原始记录；图片按 id 走 CDN 模板补齐。
     */
    adopt(rows, rankBase) {
      this.state = this.readState();
      if (!this.cateMap || !Object.keys(this.cateMap).length) {
        this.cateMap = this.readCateMap();
      }
      this.items = this.build(rows, rankBase || 0);
      this.rev += 1;
      return this.items;
    },

    /** 行数据：从表格行的 React props 上取 TanStack 实例，不受虚拟滚动影响 */
    readTable() {
      const trs = Array.prototype.slice
        .call(document.querySelectorAll('tbody tr[data-slot=table-row]'))
        .filter((tr) => tr.children.length > 3);
      if (!trs.length) return [];

      const propsKey = Object.keys(trs[0]).find((key) => key.indexOf('__reactProps') === 0);
      if (!propsKey) return [];

      let table = null;
      let single = null;
      const seen = new Set();

      const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
        if (table && single) return;
        seen.add(node);
        if (!Array.isArray(node) && typeof node.getRowModel === 'function') { table = node; return; }
        if (!Array.isArray(node) && 'sale' in node && 'product_title' in node) { single = node; return; }
        const keys = Object.keys(node);
        for (let i = 0; i < keys.length; i += 1) {
          const key = keys[i];
          if (key.indexOf('__') === 0) continue;
          try { walk(node[key], depth + 1); } catch (e) { /* 访问器抛错就跳过 */ }
        }
      };
      walk(trs[0][propsKey], 0);

      if (table) {
        try {
          const model = table.getRowModel();
          if (model && Array.isArray(model.rows)) return model.rows.map((row) => row.original);
        } catch (e) { /* 退到单行 */ }
      }
      return single ? [single] : [];
    },

    /** 图片：挂载行的背景图，按商品 id 建表；缺的走 CDN 模板 */
    readImages() {
      const map = {};
      const trs = document.querySelectorAll('tbody tr[data-slot=table-row]');
      for (let i = 0; i < trs.length; i += 1) {
        const cell = trs[i].children[1];
        if (!cell) continue;
        const box = Array.prototype.slice.call(cell.querySelectorAll('div'))
          .find((node) => node.style && node.style.backgroundImage);
        if (!box) continue;
        const matched = (box.style.backgroundImage || '').match(/url\("?(.+?)"?\)/);
        if (!matched) continue;
        const url = matched[1];
        const idMatched = url.match(/tiktok\.product\/(\d+)/);
        if (idMatched) map[idMatched[1]] = url;
      }
      return map;
    },

    /** 类目字典：本地缓存 ∪ 页面 Cascader（类目筛选器展开过才存在） */
    readCateMap() {
      const cached = Util.readJSON(EX.CATE_CACHE_KEY) || {};
      const live = this.scanCascader();
      if (!live) return cached;

      let added = 0;
      Object.keys(live).forEach((id) => {
        if (!cached[id]) { cached[id] = live[id]; added += 1; }
      });
      if (added) Util.writeJSON(EX.CATE_CACHE_KEY, cached);
      return cached;
    },

    /** 从 antd Cascader 的 fiber props 上读出整棵类目树（value → label） */
    scanCascader() {
      const nodes = document.querySelectorAll('[class*=cascader]');
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        const fiberKey = Object.keys(node).find((key) => key.indexOf('__reactFiber') === 0);
        if (!fiberKey) continue;

        let fiber = node[fiberKey];
        for (let depth = 0; fiber && depth < 25; depth += 1) {
          const props = fiber.memoizedProps;
          if (props && Array.isArray(props.options) && props.options.length > 3) {
            const map = {};
            const walkOptions = (list) => {
              for (let j = 0; j < list.length; j += 1) {
                const option = list[j];
                if (!option) continue;
                if (option.value != null) map[String(option.value)] = String(option.label || '');
                if (option.children) walkOptions(option.children);
              }
            };
            walkOptions(props.options);
            return Object.keys(map).length ? map : null;
          }
          fiber = fiber.return;
        }
      }
      return null;
    },

    /**
     * 页面顶部的搜索词。切换语言后 placeholder 会跟着变，所以按几种常见写法匹配；
     * 都匹配不上就退回「上一次搜索接口请求里的 query」。
     */
    searchText() {
      // 站点的搜索框没有 type 属性（默认 text），按 placeholder 认最稳
      const nodes = document.querySelectorAll('input');
      for (let i = 0; i < nodes.length; i += 1) {
        const kind = String(nodes[i].type || 'text').toLowerCase();
        if (kind !== 'text' && kind !== 'search') continue;
        const ph = String(nodes[i].placeholder || '');
        if (/商品|类目|product|categor|search|搜索|สินค้า/i.test(ph)) {
          return String(nodes[i].value || '').trim();
        }
      }
      return this.lastQuery || '';
    },

    /** 页面状态：国家 / 日期区间 / 语言 / 币种 */
    readState() {
      const state = { country: '', start: '', end: '', language: 'zh-CN', currency: 'CNY' };

      const regionNode = document.querySelector('#region-dropdown .whitespace-nowrap');
      const regionText = regionNode ? (regionNode.innerText || '').trim().toUpperCase() : '';
      if (/^[A-Z]{2}$/.test(regionText)) state.country = regionText;
      else {
        const matched = location.href.match(/region=([A-Za-z]{2})/);
        state.country = matched ? matched[1].toUpperCase() : '';
      }

      const range = this.readStorage('sessionStorage', EX.STATE_DATE_KEY);
      if (Array.isArray(range) && range.length === 2 && range[0] && range[1]) {
        state.start = String(range[0]);
        state.end = String(range[1]);
      }

      state.language = this.readStorage('localStorage', EX.LANG_KEY) || 'zh-CN';
      state.currency = this.readStorage('localStorage', EX.CUR_KEY) || 'CNY';
      if (typeof state.language !== 'string') state.language = 'zh-CN';
      if (typeof state.currency !== 'string') state.currency = 'CNY';
      return state;
    },

    /** 读一条 storage 里的 JSON（读不到返回 null） */
    readStorage(kind, key) {
      try {
        const raw = window[kind].getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },

    /** 原始行 → 导出记录（22 列终值；数字已是数字，比例已是小数） */
    build(rawRows, rankBase) {
      const state = this.state;
      const base = rankBase || 0;
      const query = this.searchText();
      const dateRange = state.start && state.end
        ? state.start + ' ~ ' + state.end
        : '####-##-## ~ ####-##-##';

      return rawRows.map((raw, index) => {
        if (!raw || typeof raw !== 'object') return null;
        const id = String(raw.id || '').trim();
        const cateIds = [raw.pri_cate_id, raw.sec_cate_id, raw.ter_cate_id];
        return {
          id,
          query,
          country: state.country || '',
          // 接口不带 rank：页面上的 101~150 就是 (页码-1)×每页条数+序号，这里用同一个算式
          rank: raw.rank == null ? base + index + 1 : raw.rank,
          title: Fmt.text(raw.product_title),
          translation: '',
          imageUrl: this.images[id] || (id ? EX.IMAGE_TPL.replace('{id}', id) : ''),
          cateIds,
          price: Fmt.priceRange(raw.min_real_price, raw.max_real_price),
          avgPrice: Fmt.amount(raw.unit_price),
          sales: Fmt.intOf(raw.sale),
          launch: Fmt.text(raw.launch_date),
          rating: Fmt.toNumber(raw.product_rating),
          gmv: Fmt.amount(raw.revenue),
          gmvGrowth: Fmt.percent(raw.revenue_grouping_rate),
          shipping: Fmt.amount(raw.shipping_fee),
          commission: Fmt.percent(raw.commission_rate),
          liveGmv: Fmt.amount(raw.live_revenue),
          videoGmv: Fmt.amount(raw.video_revenue),
          cardGmv: Fmt.amount(raw.showcase_revenue),
          creatorNum: Fmt.intOf(raw.creator_num),
          creatorRate: Fmt.percent(raw.creator_conversion_ratio),
          detailUrl: this.detailUrl(id),
          tiktokUrl: this.tiktokUrl(id),
          dateRange,

          // —— 扩展列（默认不导出，设置里逐个打开）——
          skuMax: Fmt.amount(raw.max_real_price),
          skuMin: Fmt.amount(raw.min_real_price),
          gmvA: Fmt.amount(raw.gmv_A),
          gmvB: Fmt.amount(raw.gmv_B),
          trend: this.trendCell(raw.revenue_trend),
          shopType: this.deliveryText(raw.delivery_type),
          fullService: this.flagText(raw.is_full_service),
          overseas: this.flagText(raw.is_overseas),
          tokopedia: this.flagText(raw.is_tokopedia)
        };
      }).filter(Boolean);
    },

    /**
     * 补齐类目名：行里出现的 ID 有任何一个不在字典里时，
     * 展开左侧「类目」筛选器（点开 → 下一帧读 → 原样收回），读一次整棵树并持久化。
     * 全程只点这一个折叠头，不选值、不筛数据、不改 URL。
     */
    async ensureCategory(items) {
      const missing = items.some((item) => (item.cateIds || []).some((id) => {
        if (id == null || id === '') return false;
        const name = this.cateMap[String(id)];
        return !name || String(name) === String(id);
      }));
      if (!missing) return false;

      const anchor = document.getElementById('Category_guild');
      if (!anchor || !anchor.parentElement) return false;

      const wasOpen = document.querySelectorAll('[class*=cascader]').length > 0;
      if (!wasOpen) anchor.parentElement.click();

      let map = null;
      for (let attempt = 0; attempt < 3 && !map; attempt += 1) {
        await Fmt.nextFrame();
        map = this.scanCascader();
      }
      if (!wasOpen) anchor.parentElement.click();

      if (!map) return false;
      let added = 0;
      Object.keys(map).forEach((id) => {
        if (!this.cateMap[id]) { this.cateMap[id] = map[id]; added += 1; }
      });
      if (added) Util.writeJSON(EX.CATE_CACHE_KEY, this.cateMap);
      return added > 0;
    },

    /** 三级类目：名字缺失的层级保留 ID，层级不合并 */
    categoryText(ids) {
      const parts = ids
        .filter((id) => id != null && id !== '')
        .map((id) => this.cateMap[String(id)] || String(id));
      return parts.length ? parts.join(' > ') : EX.PLACEHOLDER;
    },

    /** Kalodata 详情页链接：带上语言/币种/国家/日期区间 */
    detailUrl(id) {
      const state = this.state;
      const region = state.country || 'O#O';
      const known = state.start && state.end;
      const raw = JSON.stringify([state.start || '####-##-##', state.end || '####-##-##']);
      const range = known ? encodeURIComponent(raw) : raw;
      return 'https://www.kalodata.com/product/detail?id=' + (id || EX.PLACEHOLDER) +
        '&language=' + (state.language || EX.PLACEHOLDER) +
        '&currency=' + (state.currency || EX.PLACEHOLDER) +
        '&region=' + region +
        '&dateRange=' + range;
    },

    tiktokUrl(id) {
      return 'https://shop.tiktok.com/view/product/' + (id || EX.PLACEHOLDER) +
        '?region=' + (this.state.country || 'O#O') + '&locale=en';
    },

    /** 逐日成交额：数组 → 紧凑 JSON 串（与 Python 的 trend_cell 同口径） */
    trendCell(values) {
      if (!Array.isArray(values)) return '';
      const nums = values.filter((value) => typeof value === 'number' && isFinite(value))
        .map((value) => Math.round(value * 100) / 100);
      return nums.length ? JSON.stringify(nums) : '';
    },

    /** 店铺类型：local → 本土店，global → 跨境店，其他原样 */
    deliveryText(value) {
      const raw = String(value == null ? '' : value).trim();
      if (!raw) return '';
      return EX.DELIVERY_CN[raw.toLowerCase()] || raw;
    },

    /** 店铺标记：1 → 是，0 → 否，其余留空 */
    flagText(value) {
      if (value === 1 || value === '1' || value === true) return '是';
      if (value === 0 || value === '0' || value === false) return '否';
      return '';
    }
  };

  /* ---------- §10.4 翻译 ---------- */

  const Trans = {
    cache: null,

    load() {
      if (!this.cache) this.cache = Util.readJSON(EX.TRANS_CACHE_KEY) || {};
      return this.cache;
    },

    get(text) {
      return this.load()[text] || '';
    },

    put(text, value) {
      if (!value) return;
      this.load()[text] = value;
    },

    /** 落盘：超出上限时按插入顺序丢最早的条目 */
    save() {
      const cache = this.load();
      const keys = Object.keys(cache);
      if (keys.length > EX.TRANS_CACHE_MAX) {
        keys.slice(0, keys.length - EX.TRANS_CACHE_MAX).forEach((key) => { delete cache[key]; });
      }
      Util.writeJSON(EX.TRANS_CACHE_KEY, cache);
    },

    /** 单条：POST 接口，超时即放弃（不重试） */
    async fetchOne(text) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EX.TRANS_TIMEOUT);
      try {
        const resp = await fetch(EX.TRANS_URL, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, to: Data.state.language || 'zh-CN' }),
          signal: controller.signal
        });
        const json = await resp.json();
        return json && json.success && json.data ? String(json.data).trim() : '';
      } catch (e) {
        return '';
      } finally {
        clearTimeout(timer);
      }
    },

    /** 批量：只翻译缓存里没有的文案，并发上限 EX.TRANS_CONCURRENCY */
    async ensure(items, onProgress, deep) {
      const pending = [];
      const seen = new Set();

      items.forEach((item) => {
        item.translation = this.get(item.title) || '';
        if (item.translation || !item.title || item.title === EX.PLACEHOLDER) return;
        if (seen.has(item.title)) return;
        seen.add(item.title);
        pending.push(item.title);
      });

      const total = pending.length;
      if (!total) return 0;

      const results = {};
      let cursor = 0;
      let done = 0;

      const worker = async () => {
        while (cursor < pending.length) {
          const text = pending[cursor];
          cursor += 1;
          const value = await this.fetchOne(text);
          if (value) { results[text] = value; this.put(text, value); }
          done += 1;
          if (onProgress) onProgress(done, total);
        }
      };

      const workers = [];
      const size = Math.min(EX.TRANS_CONCURRENCY, total);
      for (let i = 0; i < size; i += 1) workers.push(worker());
      await Promise.all(workers);
      this.save();

      items.forEach((item) => {
        item.translation = results[item.title] || this.get(item.title) || '';
      });
      if (deep) await this.deepFill(items);
      return Object.keys(results).length;
    },

    /**
     * 导出兜底：接口没回译文的，先重试一次接口，仍缺的用页面翻译弹窗补齐（上限 30 条）。
     * 仅在 deep=true（导出）时执行。
     */
    async deepFill(items) {
      const gaps = () => items.filter((it) => !it.translation && it.title && it.title !== EX.PLACEHOLDER);
      let rest = gaps();
      if (!rest.length) return 0;

      // ① 重试一次接口
      let filled = 0;
      for (let i = 0; i < rest.length; i += 1) {
        const value = await this.fetchOne(rest[i].title);
        if (!value) continue;
        rest[i].translation = value;
        this.put(rest[i].title, value);
        filled += 1;
      }
      this.save();

      // ② 仍缺的用页面弹窗补，上限 30 条
      rest = gaps().slice(0, 30);
      for (let i = 0; i < rest.length; i += 1) {
        const value = await this.fromPage(rest[i]);
        if (value) {
          rest[i].translation = value;
          this.put(rest[i].title, value);
          filled += 1;
        }
      }
      if (filled) this.save();
      return filled;
    },

    /** 站点自带的翻译弹窗：点行内第 2 个按钮 → 读弹窗译文 → 关掉 */
    async fromPage(item) {
      const index = Data.items.indexOf(item);
      const tr = document.querySelectorAll('tbody tr[data-slot=table-row]')[index];
      const cell = tr && tr.children[1];
      const btn = cell && cell.querySelectorAll('button')[1];
      if (!btn) return '';
      btn.click();

      let modal = null;
      for (let i = 0; i < 12 && !modal; i += 1) {
        await new Promise((done) => setTimeout(done, 100));
        modal = document.querySelector('.Component_TranslateModal');
      }
      if (!modal) return '';

      /*
       * 弹窗文本是「原文一行 → 译文一行」：
       * 按行切开，找到原标题所在行，取下一行作为译文。
       */
      const lines = String(modal.innerText || '')
        .split(String.fromCharCode(10))
        .map((line) => line.trim())
        .filter(Boolean);
      const at = lines.indexOf(String(item.title || '').trim());
      const text = at >= 0 ? lines[at + 1] || '' : '';

      const wrap = document.querySelector('.ant-modal-wrap');
      if (wrap) wrap.click();
      else if (modal.querySelector('.ant-modal-close')) modal.querySelector('.ant-modal-close').click();
      await new Promise((done) => setTimeout(done, 120));
      return text;
    }
  };

  /* ---------- §10.5 组装单元格 ---------- */

  const Sheet = {
    /** 记录 → { headers, widths, rows: [[cell]] }；每个 cell 是 { xf, type, value } */
    build(items) {
      const cols = ExCfg.cols();
      const headers = cols.map((col) => col.header);
      const widths = cols.map((col) => ExCfg.widthOf(col));
      const linkIndex = cols.findIndex((col) => col.key === 'imageUrl');
      const linkLetter = Xlsx.colLetter(linkIndex + 1);

      const rows = items.map((item, rowIndex) => {
        const excelRow = rowIndex + 2;      // 表头占第 1 行
        return cols.map((col) => {
          // 类目在导出这一刻才拼：类目名可能是刚补齐的
          const value = col.key === 'category' ? Data.categoryText(item.cateIds) : item[col.key];

          if (col.kind === 'image') {
            return item.imageUrl
              ? { xf: XF.center, type: 'f', value: 'IMAGE(' + linkLetter + excelRow + ')' }
              : { xf: XF.center, type: 'empty' };
          }

          const xf = XF[XF_OF[col.kind] || 'center'];
          if (value == null || value === '') return { xf, type: 'empty' };
          if (typeof value === 'number' && isFinite(value)) return { xf, type: 'n', value };
          return { xf, type: 's', value: String(value) };
        });
      });

      return { headers, widths, rows };
    }
  };

  /* ---------- §10.6 ZIP（store 模式，无压缩） ---------- */

  const Zip = {
    crcTable: (function () {
      const table = new Uint32Array(256);
      for (let i = 0; i < 256; i += 1) {
        let value = i;
        for (let bit = 0; bit < 8; bit += 1) {
          value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[i] = value >>> 0;
      }
      return table;
    })(),

    crc32(bytes) {
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < bytes.length; i += 1) {
        crc = (crc >>> 8) ^ this.crcTable[(crc ^ bytes[i]) & 0xFF];
      }
      return (crc ^ 0xFFFFFFFF) >>> 0;
    },

    utf8(text) {
      return new TextEncoder().encode(text);
    },

    dosTime() {
      const now = new Date();
      return {
        time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
        date: ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
      };
    },

    concat(list) {
      let total = 0;
      list.forEach((chunk) => { total += chunk.length; });
      const out = new Uint8Array(total);
      let offset = 0;
      list.forEach((chunk) => { out.set(chunk, offset); offset += chunk.length; });
      return out;
    },

    /**
     * 打包：每个条目写本地头 + 原始数据；末尾写中央目录与 EOCD。
     * flags 高位 0x0800 表示文件名为 UTF-8，Excel 与各家解压器都认。
     */
    build(files) {
      const entries = files.map((file) => {
        const data = typeof file.data === 'string' ? this.utf8(file.data) : file.data;
        return { name: this.utf8(file.name), data, crc: this.crc32(data) };
      });

      const stamp = this.dosTime();
      const chunks = [];
      const central = [];
      let offset = 0;

      entries.forEach((entry) => {
        const local = new Uint8Array(30 + entry.name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true);
        lv.setUint16(8, 0, true);
        lv.setUint16(10, stamp.time, true);
        lv.setUint16(12, stamp.date, true);
        lv.setUint32(14, entry.crc, true);
        lv.setUint32(18, entry.data.length, true);
        lv.setUint32(22, entry.data.length, true);
        lv.setUint16(26, entry.name.length, true);
        lv.setUint16(28, 0, true);
        local.set(entry.name, 30);

        const head = new Uint8Array(46 + entry.name.length);
        const hv = new DataView(head.buffer);
        hv.setUint32(0, 0x02014b50, true);
        hv.setUint16(4, 20, true);
        hv.setUint16(6, 20, true);
        hv.setUint16(8, 0x0800, true);
        hv.setUint16(10, 0, true);
        hv.setUint16(12, stamp.time, true);
        hv.setUint16(14, stamp.date, true);
        hv.setUint32(16, entry.crc, true);
        hv.setUint32(20, entry.data.length, true);
        hv.setUint32(24, entry.data.length, true);
        hv.setUint16(28, entry.name.length, true);
        hv.setUint16(30, 0, true);
        hv.setUint16(32, 0, true);
        hv.setUint16(34, 0, true);
        hv.setUint16(36, 0, true);
        hv.setUint32(38, 0, true);
        hv.setUint32(42, offset, true);
        head.set(entry.name, 46);

        chunks.push(local, entry.data);
        central.push(head);
        offset += local.length + entry.data.length;
      });

      let centralSize = 0;
      central.forEach((head) => { centralSize += head.length; });

      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, entries.length, true);
      ev.setUint16(10, entries.length, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, offset, true);

      return this.concat(chunks.concat(central).concat([end]));
    }
  };

  /* ---------- §10.7 XLSX 写出 ---------- */

  const Xlsx = {
    /** 列号 → 列字母（1 → A） */
    colLetter(index) {
      let num = index;
      let text = '';
      while (num > 0) {
        const rest = (num - 1) % 26;
        text = String.fromCharCode(65 + rest) + text;
        num = Math.floor((num - 1) / 26);
      }
      return text;
    },

    /** XML 转义（同时剔掉 XML 不允许的控制字符） */
    escape(text) {
      return String(text == null ? '' : text)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },

    /** 单个单元格：s = 样式下标；数值走 <v>，文本走 inlineStr，公式走 <f> */
    cellXml(ref, cell) {
      if (!cell || cell.type === 'empty') {
        return '<c r="' + ref + '" s="' + (cell ? cell.xf : XF.center) + '"/>';
      }
      if (cell.type === 'n') {
        return '<c r="' + ref + '" s="' + cell.xf + '"><v>' + cell.value + '</v></c>';
      }
      if (cell.type === 'f') {
        return '<c r="' + ref + '" s="' + cell.xf + '"><f>' + this.escape(cell.value) + '</f></c>';
      }
      return '<c r="' + ref + '" s="' + cell.xf + '" t="inlineStr"><is><t xml:space="preserve">' +
        this.escape(cell.value) + '</t></is></c>';
    },

    /** 工作表：冻结表头、自动筛选、横向铺满打印、只给内容区画框线（边框来自样式） */
    sheetXml(sheet) {
      const lastCol = this.colLetter(sheet.headers.length);
      const lastRow = sheet.rows.length + 1;
      const parts = [];

      parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
      parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
      parts.push('<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
      parts.push('<dimension ref="A1:' + lastCol + lastRow + '"/>');
      parts.push('<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
        '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>');
      parts.push('<sheetFormatPr defaultRowHeight="15"/>');

      parts.push('<cols>' + sheet.widths.map((width, i) =>
        '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + width + '" customWidth="1"/>'
      ).join('') + '</cols>');

      parts.push('<sheetData>');
      parts.push('<row r="1" ht="' + EX.HEADER_HEIGHT + '" customHeight="1">' +
        sheet.headers.map((header, i) =>
          this.cellXml(this.colLetter(i + 1) + '1', { xf: XF.header, type: 's', value: header })
        ).join('') + '</row>');

      sheet.rows.forEach((cells, index) => {
        const rowNo = index + 2;
        parts.push('<row r="' + rowNo + '" ht="' + EX.ROW_HEIGHT + '" customHeight="1">' +
          cells.map((cell, col) => this.cellXml(this.colLetter(col + 1) + rowNo, cell)).join('') +
          '</row>');
      });
      parts.push('</sheetData>');

      parts.push('<autoFilter ref="A1:' + lastCol + lastRow + '"/>');
      parts.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>');
      parts.push('<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>');
      parts.push('</worksheet>');
      return parts.join('');
    },

    /**
     * 样式表：3 套字体（正文 / 表头白字加粗 / 链接蓝字下划线）、
     * 2 套边框（细线 / 表头 medium 下边线）、7 个单元格样式。
     * 10 号数字格式 = 0.00%，比例列专用。
     */
    stylesXml() {
      return [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        '<fonts count="3">',
        '<font><sz val="12"/><color rgb="FF1F2328"/><name val="微软雅黑"/><charset val="134"/></font>',
        '<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/><charset val="134"/></font>',
        '<font><u/><sz val="12"/><color rgb="FF0563C1"/><name val="微软雅黑"/><charset val="134"/></font>',
        '</fonts>',
        '<fills count="3">',
        '<fill><patternFill patternType="none"/></fill>',
        '<fill><patternFill patternType="gray125"/></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>',
        '</fills>',
        '<borders count="3">',
        '<border><left/><right/><top/><bottom/><diagonal/></border>',
        '<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right>' +
          '<top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border>',
        '<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right>' +
          '<top style="thin"><color rgb="FF000000"/></top><bottom style="medium"><color rgb="FF1F4E79"/></bottom><diagonal/></border>',
        '</borders>',
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
        '<cellXfs count="7">',
        // 0 无格式
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
        // 1 表头：白字加粗 / 深蓝底 / 上下居中 + 左右居中 / 不换行
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
          '<alignment horizontal="center" vertical="center" wrapText="0"/></xf>',
        // 2 正文文本：左对齐 + 上下居中 + 换行（长标题折成多行）
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' +
          '<alignment horizontal="left" vertical="center" wrapText="1"/></xf>',
        // 3 数值 / 短文本：左对齐 + 上下居中
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' +
          '<alignment horizontal="left" vertical="center" wrapText="1"/></xf>',
        // 4 不换行（每日成交金额）
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' +
          '<alignment horizontal="left" vertical="center" wrapText="0"/></xf>',
        // 5 链接：蓝字下划线 / 左对齐
        '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">' +
          '<alignment horizontal="left" vertical="center" wrapText="1"/></xf>',
        // 6 百分比：0.00% / 左对齐
        '<xf numFmtId="10" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">' +
          '<alignment horizontal="left" vertical="center" wrapText="0"/></xf>',
        '</cellXfs>',
        '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>',
        '</styleSheet>'
      ].join('');
    },

    /** 打包成 xlsx 字节流 */
    build(sheet) {
      const files = [
        {
          name: '[Content_Types].xml',
          data: [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
            '<Default Extension="xml" ContentType="application/xml"/>',
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
            '</Types>'
          ].join('')
        },
        {
          name: '_rels/.rels',
          data: [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
            '</Relationships>'
          ].join('')
        },
        {
          name: 'xl/workbook.xml',
          data: [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
              'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
            '<sheets><sheet name="商品列表" sheetId="1" r:id="rId1"/></sheets>',
            /* 打印标题：横向铺满时每页重复第 1 行（Excel 用定义名保存） */
            '<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">\'商品列表\'!$1:$1</definedName></definedNames>',
            '</workbook>'
          ].join('')
        },
        {
          name: 'xl/_rels/workbook.xml.rels',
          data: [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
            '</Relationships>'
          ].join('')
        },
        { name: 'xl/styles.xml', data: this.stylesXml() },
        { name: 'xl/worksheets/sheet1.xml', data: this.sheetXml(sheet) }
      ];
      return Zip.build(files);
    },

    /** 触发下载：先整份生成完再点，避免留下半成品文件 */
    download(bytes, filename) {
      const blob = new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },

    /** 文件名：kalodata_ranking_VN_20261111_215959.xlsx（带上当前国家，方便区分站点） */
    filename() {
      const now = new Date();
      const pad = (num) => String(num).padStart(2, '0');
      const stamp = String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate()) +
        '_' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
      const country = String(Data.state.country || '').trim();
      return EX.FILE_PREFIX + (country ? country + '_' : '') + stamp + '.xlsx';
    }
  };

  /* ---------- §10.7b 合并导出（读回自己写的 xlsx，拼成一份） ---------- */

  /**
   * 只认自己导出的那套 xlsx：单表、样式表索引固定。
   * 解包用浏览器自带的 DecompressionStream('deflate-raw')，不引第三方库。
   */
  const Merge = {
    async run(files) {
      if (!files || !files.length) return;
      const books = [];
      for (let i = 0; i < files.length; i += 1) {
        try {
          const book = await this.readBook(files[i]);
          if (book && book.rows.length) books.push(book);
        } catch (e) { /* 坏文件跳过 */ }
      }
      if (!books.length) {
        View.toast('没读到有效的 xlsx（只支持本脚本导出的文件）');
        return;
      }

      const headers = books[0].headers;
      const widths = books[0].widths;
      const rows = [];
      books.forEach((book) => {
        book.rows.slice(1).forEach((line) => rows.push(line));   // 每份的第 1 行都是表头，跳过
      });
      if (!rows.length) {
        View.toast('这些文件里只有表头，没有数据行');
        return;
      }

      // 公式（IMAGE(V2)）里带着原文件的行号，拼接后要改成新行号
      rows.forEach((line, index) => {
        const rowNo = index + 2;
        line.forEach((cell) => {
          if (!cell || cell.type !== 'f') return;
          cell.value = String(cell.value).replace(/([A-Z]+)\d+/, '$1' + rowNo);
        });
      });

      const sheet = { headers, widths, rows };
      Xlsx.download(Xlsx.build(sheet), Xlsx.filename().replace(/\.xlsx$/, '_合并.xlsx'));
      View.toast('已合并 ' + books.length + ' 个文件、' + rows.length + ' 行');
    },

    /** 读一个 xlsx → { headers, widths, rows } */
    async readBook(file) {
      const buf = new Uint8Array(await file.arrayBuffer());
      const zip = await this.unzip(buf);
      const sheetXml = this.text(zip['xl/worksheets/sheet1.xml']);
      if (!sheetXml) return null;
      const shared = this.sharedStrings(this.text(zip['xl/sharedStrings.xml']));
      const rows = this.parseSheet(sheetXml, shared);
      if (!rows.length) return null;

      const headRow = rows[0];
      const headers = [];
      for (let i = 0; i < headRow.length; i += 1) {
        headers.push(headRow[i] ? String(headRow[i].value == null ? '' : headRow[i].value) : '');
      }

      const widths = [];
      const colRe = /<col [^>]*width="([\d.]+)"[^>]*\/>/g;
      let m;
      while ((m = colRe.exec(sheetXml))) widths.push(Number(m[1]));
      while (widths.length < headers.length) widths.push(COL_WIDTH_DEFAULT);

      return { headers, widths: widths.slice(0, headers.length), rows };
    },

    text(bytes) {
      return bytes ? new TextDecoder().decode(bytes) : '';
    },

    /** 极简 unzip：走中央目录，deflate-raw 交给浏览器 */
    async unzip(buf) {
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      let eocd = -1;
      const floor = Math.max(0, buf.length - 66000);
      for (let i = buf.length - 22; i >= floor; i -= 1) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) return {};

      const count = view.getUint16(eocd + 10, true);
      let ptr = view.getUint32(eocd + 16, true);
      const out = {};

      for (let i = 0; i < count && ptr + 46 <= buf.length; i += 1) {
        if (view.getUint32(ptr, true) !== 0x02014b50) break;
        const method = view.getUint16(ptr + 10, true);
        const compSize = view.getUint32(ptr + 20, true);
        const nameLen = view.getUint16(ptr + 28, true);
        const extraLen = view.getUint16(ptr + 30, true);
        const commentLen = view.getUint16(ptr + 32, true);
        const localOff = view.getUint32(ptr + 42, true);
        const name = this.text(buf.subarray(ptr + 46, ptr + 46 + nameLen));

        const lNameLen = view.getUint16(localOff + 26, true);
        const lExtraLen = view.getUint16(localOff + 28, true);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(start, start + compSize);
        out[name] = method === 0 ? raw : await this.inflate(raw);

        ptr += 46 + nameLen + extraLen + commentLen;
      }
      return out;
    },

    async inflate(bytes) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },

    sharedStrings(xml) {
      if (!xml) return [];
      const list = [];
      const re = /<si>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = re.exec(xml))) {
        const parts = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
        list.push(parts.map((t) => this.unescape(t.replace(/<[^>]+>/g, ''))).join(''));
      }
      return list;
    },

    /** 行 → [{ xf, type, value }]，样式索引原样保留（和写出时的 cellXfs 一一对应） */
    parseSheet(xml, shared) {
      const rows = [];
      const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
      let rm;
      while ((rm = rowRe.exec(xml))) {
        const cells = [];
        const cellRe = /<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let cm;
        while ((cm = cellRe.exec(rm[1]))) {
          const attrs = cm[1] || '';
          const inner = cm[2] || '';
          const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1] || '';
          const index = this.colIndex(ref);
          const xf = Number((attrs.match(/s="(\d+)"/) || [])[1] || 3);
          const kind = (attrs.match(/t="([^"]+)"/) || [])[1] || '';
          const num = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          const raw = (inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
          const formula = (inner.match(/<f[^>]*>([\s\S]*?)<\/f>/) || [])[1];

          let cell;
          if (formula != null) cell = { xf, type: 'f', value: this.unescape(formula) };
          else if (kind === 's' && num != null) cell = { xf, type: 's', value: shared[Number(num)] || '' };
          else if (raw != null) cell = { xf, type: 's', value: this.unescape(raw) };
          else if (num != null) cell = { xf, type: 'n', value: Number(num) };
          else cell = { xf, type: 'empty' };
          if (index >= 0) cells[index] = cell;
        }
        for (let i = 0; i < cells.length; i += 1) {
          if (!cells[i]) cells[i] = { xf: 3, type: 'empty' };
        }
        rows.push(cells);
      }
      return rows;
    },

    colIndex(letters) {
      if (!letters) return -1;
      let n = 0;
      for (let i = 0; i < letters.length; i += 1) n = n * 26 + (letters.charCodeAt(i) - 64);
      return n - 1;
    },

    unescape(text) {
      return String(text)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (all, code) => String.fromCharCode(Number(code)))
        .replace(/&amp;/g, '&');
    }
  };


  /* ═══════════════════════════════════════════════════════════════════════
   * §11  业务层 · 展示（商品翻译卡 / 搜索高亮 / 页面滚动对齐 / 导出 / 设置）
   *
   *    §11.1 高亮词库   常驻「要高亮显示的文本」，存在 localStorage
   *    §11.2 命中计算   纯函数：把文本切成「普通段 / 命中段」，再拼成 HTML
   *    §11.3 列表视图   商品卡：图片 + 中文翻译 + 原文 + 价格 / 销量 + 悬停浮窗
   *    §11.4 滚动对齐   页面滚到哪一行，列表就对齐到同一件商品
   *    §11.5 导出       点选 + 生成 xlsx（列计划与列宽来自 §10 的 ExCfg）
   *    §11.6 设置界面   扩展列开关
   *    §11.7 对外入口   Show.render / refresh / autoFill
   *
   *  两条交互约定（与页面视觉联动相关的部分都在 §11.4）：
   *    · 在面板里滚动 → 只滚商品卡列表，页面一动不动（快速浏览中文名）；
   *    · 在页面上滚动 → 列表自动贴住页面当前可见的第一行（左右对照）。
   * ═══════════════════════════════════════════════════════════════════════ */

  /* ---------- §11.1 高亮词库 ---------- */

  const Marks = {
    list: [],
    max: 40,          // 词库上限
    maxLen: 40,       // 单个词条长度上限

    load() {
      const saved = Util.readJSON(CONFIG.MARK_KEY);
      const raw = Array.isArray(saved) ? saved : [];
      this.list = raw
        .filter((text) => typeof text === 'string')
        .map((text) => text.trim())
        .filter((text, index, all) => text && text.length <= this.maxLen && all.indexOf(text) === index)
        .slice(0, this.max);
      return this.list;
    },

    save() {
      Util.writeJSON(CONFIG.MARK_KEY, this.list);
    },

    add(text) {
      const value = String(text == null ? '' : text).trim().slice(0, this.maxLen);
      if (!value || this.list.indexOf(value) >= 0) return false;
      if (this.list.length >= this.max) this.list.shift();
      this.list.push(value);
      this.save();
      return true;
    },

    remove(text) {
      const index = this.list.indexOf(text);
      if (index < 0) return false;
      this.list.splice(index, 1);
      this.save();
      return true;
    },

    clear() {
      this.list = [];
      this.save();
    }
  };

  /* ---------- §11.2 命中计算（纯函数） ---------- */

  const Hit = {
    keyword: '',      // 搜索框的临时词，不持久化

    /** 参与高亮的词：搜索词优先，其余来自词库；长词在前，避免短词把长词切碎 */
    terms() {
      const out = [];
      const keyword = this.keyword.trim();
      if (keyword) out.push({ text: keyword, search: true });
      Marks.list.forEach((text) => {
        if (text && text !== keyword) out.push({ text, search: false });
      });
      return out.sort((a, b) => b.text.length - a.text.length);
    },

    /** 文本 → HTML：命中段包 <mark>，其余逐字符转义 */
    html(text) {
      const raw = String(text == null ? '' : text);
      const terms = this.terms();
      if (!raw || !terms.length) return Util.esc(raw);

      const lower = raw.toLowerCase();
      let out = '';
      let index = 0;
      while (index < raw.length) {
        let hit = null;
        for (let i = 0; i < terms.length; i += 1) {
          if (lower.startsWith(terms[i].text.toLowerCase(), index)) { hit = terms[i]; break; }
        }
        if (hit) {
          out += '<mark class="sp-hit' + (hit.search ? ' search' : '') + '">' +
            Util.esc(raw.substr(index, hit.text.length)) + '</mark>';
          index += hit.text.length;
        } else {
          out += Util.esc(raw[index]);
          index += 1;
        }
      }
      return out;
    },

    /** 命中次数（工具条上的「命中 N」） */
    count(text) {
      const raw = String(text == null ? '' : text).toLowerCase();
      const terms = this.terms();
      if (!raw || !terms.length) return 0;

      let total = 0;
      for (let i = 0; i < terms.length; i += 1) {
        const needle = terms[i].text.toLowerCase();
        let from = raw.indexOf(needle);
        while (from >= 0) {
          total += 1;
          from = raw.indexOf(needle, from + needle.length);
        }
      }
      return total;
    }
  };

  /* ---------- §11.3 列表视图 ---------- */

  const ListView = {
    tipBound: false,

    /** 铺整块展示页：工具条 + 关键词框 + 高亮词 + 商品卡 */
    render() {
      const box = View.refs.content;
      if (!box) return;

      // 整块重铺会把输入框一起换掉：把用户已经敲进去的词带过来
      const oldInput = box.querySelector('input[data-ref="spSearch"]');
      const keepText = oldInput ? oldInput.value : '';

      // 商品集合变了（换页 / 换筛选）就丢掉已失效的勾选
      const alive = new Set(Data.items.map((item) => item.id));
      Exporter.selected.forEach((id) => { if (!alive.has(id)) Exporter.selected.delete(id); });

      box.innerHTML = [
        '<div class="sp">',
        '  <div class="sp-bar">',
        '    <button class="sp-btn primary" data-sp="export">导出 Excel</button>',
        '    <button class="sp-btn sp-btn-solid" data-sp="reload">重新读取</button>',
        '    <button class="sp-btn sp-btn-solid" data-sp="pick-all" title="全选 / 取消全选（只影响导出）">全选</button>',
        '    <span class="sp-count" data-ref="spCount"></span>',
        '  </div>',
        '  <div class="sp-search">',
        '    <div class="sp-find">',
        '      <svg class="sp-find-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">',
        '        <circle cx="7" cy="7" r="4.4"></circle><path d="M10.4 10.4 14 14"></path>',
        '      </svg>',
        '      <input class="sp-input" data-ref="spSearch" type="text" autocomplete="off"',
        '             spellcheck="false" placeholder="输入关键词/回车存入">',
        '    </div>',
        '    <button class="sp-btn sp-btn-mark" data-sp="mark-add" title="存入高亮词库（回车同效）">存</button>',
        '    <button class="sp-btn sp-btn-clear" data-sp="mark-clear" title="清空输入框与已保存的词">清除</button>',
        '  </div>',
        '  <div class="sp-marks" data-ref="spMarks"></div>',
        '  <div class="sp-list" data-ref="spList"></div>',
        '</div>'
      ].join('');

      this.hideTip();
      if (keepText) {
        const input = box.querySelector('input[data-ref="spSearch"]');
        if (input) input.value = keepText;
      }
      this.paintMarks();
      this.paintList();
    },

    /** 单条商品的中文文本：先看记录，再看翻译缓存（缓存命中时记录里可能还是空的） */
    textOf(item) {
      return item.translation || Trans.get(item.title) || '';
    },

    /** 重建全部商品卡（换页 / 重新读取） */
    paintList() {
      const list = this.listEl();
      if (!list) return;
      list.innerHTML = Data.items.length
        ? Data.items.map((item) => this.cardHtml(item)).join('')
        : this.emptyHtml();
      this.hideTip();
      this.paintCount();
    },

    /** 只重写卡片里的文字（翻译回填 / 高亮词变化），保留滚动位置 */
    paintText() {
      const list = this.listEl();
      if (!list) return;
      const cards = list.querySelectorAll('[data-card]');
      for (let i = 0; i < cards.length; i += 1) {
        const card = cards[i];
        const item = this.byId(card.getAttribute('data-card'));
        if (!item) continue;

        const cn = card.querySelector('.sp-cn');
        const en = card.querySelector('.sp-en');
        const text = this.textOf(item);

        if (cn) {
          cn.innerHTML = text ? Hit.html(text) : '翻译获取中…';
          cn.classList.toggle('pending', !text);
        }
        if (en) en.innerHTML = Hit.html(item.title);
      }
      this.paintCount();
    },

    listEl() {
      return View.refs.content ? View.refs.content.querySelector('[data-ref="spList"]') : null;
    },

    byId(id) {
      for (let i = 0; i < Data.items.length; i += 1) {
        if (Data.items[i].id === id) return Data.items[i];
      }
      return null;
    },

    /** 单张卡：缩略图 + 译文 / 原文 / 序号·价格·销量·上架时间；整卡可点，点中即勾选 */
    cardHtml(item) {
      const on = Exporter.selected.has(item.id);
      const text = this.textOf(item);
      const price = this.priceText(item.price);
      const sales = this.salesText(item.sales);
      const facts = [
        '<b class="sp-rank">#' + Util.esc(item.rank) + '</b>',
        price ? '<span>' + Util.esc(price) + '</span>' : '',
        price && sales ? '<i class="sp-dot">·</i>' : '',
        sales ? '<span>' + Util.esc(sales) + '</span>' : ''
      ].join('');
      const launch = this.dateText(item.launch);
      const meta = '<span class="sp-facts">' + facts + '</span>' +
        (launch ? '<span class="sp-date" title="上架时间">' + Util.esc(launch) + '</span>' : '');

      return [
        '<div class="sp-card' + (on ? ' on' : '') + '" data-card="' + Util.esc(item.id) + '">',
        WebOpt.isOn('thumbBg')
          ? '  <span class="sp-thumb"' +
            (item.imageUrl ? ' style="background-image:url(&quot;' + Util.esc(item.imageUrl) + '&quot;)"' : '') +
            '></span>'
          : (item.imageUrl
            ? '  <img class="sp-thumb" src="' + Util.esc(item.imageUrl) + '" alt="" loading="lazy">'
            : '  <span class="sp-thumb"></span>'),
        '  <span class="sp-main">',
        '    <span class="sp-cn' + (text ? '' : ' pending') + '" title="点击复制中文名">' +
              (text ? Hit.html(text) : '翻译获取中…') + '</span>',
        '    <span class="sp-en">' + Hit.html(item.title) + '</span>',
        '    <span class="sp-meta">' + meta + '</span>',
        '  </span>',
        '</div>'
      ].join('');
    },

    /**
     * 悬停浮窗：完整中文名 + 外文名 + 序号·价格·销量·上架时间。
     * 挂在 shadow 根上（不随列表重绘），fixed 定位，贴在面板外侧并收进窗口内。
     */
    showTip(card) {
      const tip = View.refs.tip;
      const item = this.byId(card.getAttribute('data-card'));
      if (!tip || !item) return;

      this.bindTip();

      const text = this.textOf(item);
      const price = this.priceText(item.price);
      const sales = this.salesText(item.sales);

      const meta = ['#' + Util.esc(item.rank)];
      if (price) meta.push(Util.esc(price));
      if (sales) meta.push('销量 ' + Util.esc(sales));
      const launch = this.dateText(item.launch);

      tip.innerHTML = [
        '<div class="t-cn">' + (text ? Util.esc(text) : '翻译获取中…') + '</div>',
        '<div class="t-en">' + Util.esc(item.title) + '</div>',
        '<div class="t-meta"><span>' + meta.join(' · ') + '</span>' +
          (launch ? '<span class="t-date">上架 ' + Util.esc(launch) + '</span>' : '') +
        '</div>'
      ].join('');

      tip.classList.add('on');

      const rect = card.getBoundingClientRect();
      const box = tip.getBoundingClientRect();
      // 用原生视口宽度：window.innerWidth 已被伪装成宿主宽度
      const vw = NativeProbe.innerWidth() || window.innerWidth;
      const vh = window.innerHeight;

      let left = Store.state.side === SIDE.RIGHT ? rect.left - box.width - 8 : rect.right + 8;
      left = Math.min(Math.max(8, left), Math.max(8, vw - box.width - 8));
      let top = Math.min(Math.max(8, rect.top), Math.max(8, vh - box.height - 8));

      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    },

    /*
     * 浮窗要能接住指针：mouseenter 取消隐藏延时，mouseleave 重新计时。只绑一次。
     */
    bindTip() {
      const tip = View.refs.tip;
      if (!tip || this.tipBound) return;
      this.tipBound = true;
      tip.addEventListener('mouseenter', () => ShowUI.keepTip());
      tip.addEventListener('mouseleave', () => ShowUI.onCardLeave());
    },

    hideTip() {
      if (View.refs.tip) View.refs.tip.classList.remove('on');
    },

    emptyHtml() {
      return [
        '<div class="stub">',
        '  <b>未读到商品行</b>',
        '  <span>确认页面停在商品榜、筛选未筛空，再点「重新读取」。</span>',
        '</div>'
      ].join('');
    },

    /** 价格：数字补 ¥，区间 '12.7~115.42' → '¥12.7~¥115.42' */
    priceText(price) {
      if (price == null || price === '' || price === EX.PLACEHOLDER) return '';
      if (typeof price === 'number') {
        return '¥' + (Number.isInteger(price) ? price : price.toFixed(2));
      }
      const text = String(price);
      return text.indexOf('~') >= 0 ? '¥' + text.split('~').join('~¥') : '¥' + text;
    },

    /** 销量：过万折成「万」，与页面口径一致 */
    salesText(sales) {
      if (typeof sales !== 'number' || !isFinite(sales)) return '';
      return sales >= 10000 ? (sales / 10000).toFixed(2) + '万' : String(sales);
    },

    /** 上架日期：空值 / 占位符不显示 */
    dateText(launch) {
      const text = String(launch == null ? '' : launch).trim();
      return text && text !== EX.PLACEHOLDER ? text : '';
    },

    /** 高亮词条：点文字批量勾选，点 × 移除 */
    paintMarks() {
      if (!View.refs.content) return;
      const box = View.refs.content.querySelector('[data-ref="spMarks"]');
      if (!box) return;
      box.innerHTML = Marks.list.map((text) => [
        '<span class="sp-chip' + (this.markOn(text) ? ' picked' : '') + '">',
        '<span class="sp-chip-t" data-sp="mark-pick" data-mark="' + Util.esc(text) + '"',
        '      title="点击：勾选所有包含该词的商品（再点一次取消）">' + Util.esc(text) + '</span>',
        '<button data-sp="mark-del" data-mark="' + Util.esc(text) + '" title="移除">×</button></span>'
      ].join('')).join('');
      box.style.display = Marks.list.length ? '' : 'none';
    },

  /** 这个词是否已经「全选」了：匹配到的商品全被勾上才算 */
  markOn(text) {
    const key = String(text || '').toLowerCase();
    if (!key || !Data.items.length) return false;
    let total = 0;
    let on = 0;
    Data.items.forEach((item) => {
      if ((item.title + ' ' + (item.translation || '')).toLowerCase().indexOf(key) === -1) return;
      total += 1;
      if (Exporter.selected.has(item.id)) on += 1;
    });
    return total > 0 && on === total;
  },

    /** 工具条计数：已选 / 共 / 命中（行序显示在每张卡上） */
    paintCount() {
      if (!View.refs.content) return;
      const box = View.refs.content.querySelector('[data-ref="spCount"]');
      if (!box) return;

      const total = Data.items.length;
      const picked = Exporter.selected.size;
      let hits = 0;
      if (Hit.terms().length) {
        Data.items.forEach((item) => {
          hits += Hit.count(this.textOf(item)) + Hit.count(item.title);
        });
      }

      box.innerHTML = '已选 <b>' + picked + '</b>/<b>' + total + '</b>' +
        (hits ? ' · 命中 <b>' + hits + '</b>' : '');

      // 「全选」按钮随全部选中状态切换文案
      const btn = View.refs.content.querySelector('[data-sp="pick-all"]');
      if (btn) {
        const label = total > 0 && picked === total ? '取消全选' : '全选';
        if (btn.textContent !== label) btn.textContent = label;
      }
    }
  };

  /* ---------- §11.4 滚动对齐 ---------- */

  const Sync = {
    bound: false,
    rafId: 0,

    /* 结构缓存：行 / 表头 / 滚动容器只在数据重读后失效，滚动过程里不再重复查找与读样式 */
    cache: { rev: -1, rows: null, head: null, scroller: null, lastIndex: 0 },

    /**
     * 一行至少露出这么大比例才算「当前首行」。
     * sticky 表头 + 冻结的「商品信息」列会把顶端那一行压掉大半，
     * 只按「底边进来了」判断就会把压在表头底下的一行当成首行，整体错位一行。
     */
    VISIBLE_RATIO: 0.75,

    /**
     * 只绑一次。页面的纵向滚动发生在站点自己的滚动容器里，
     * scroll 事件不冒泡，所以监听必须挂在 document 的捕获阶段。
     */
    bind() {
      if (this.bound) return;
      this.bound = true;
      document.addEventListener('scroll', (event) => this.onScroll(event), { capture: true, passive: true });
      window.addEventListener('resize', () => this.schedule(), { passive: true });
    },

    /** 面板内部的滚动不参与对齐：那是「快速浏览译文」的动作，不该反过来推页面 */
    isPanelScroll(event) {
      if (event.target !== View.host) return false;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      return path.indexOf(View.host) >= 0;
    },

    onScroll(event) {
      if (!Store.state.enabled || Store.state.view !== 'show') return;
      if (!Data.items.length || this.isPanelScroll(event)) return;
      this.schedule();
    },

    /** 一帧最多对齐一次（滚动事件可能 120Hz） */
    schedule() {
      if (this.rafId) return;
      this.rafId = requestAnimationFrame(() => {
        this.rafId = 0;
        this.align();
      });
    },

    /**
     * 行 / 表头 / 滚动容器：数据重读或节点断开时才重新查找，滚动过程里复用缓存。
     * 表头与表体是两张独立的 table，只能从文档里找「正贴在滚动容器顶部」的那条 thead。
     */
    nodes() {
      const cache = this.cache;
      const rows = cache.rows;
      const alive = rows && rows.length && rows[0].isConnected && cache.rev === Data.rev;

      if (!alive) {
        cache.rows = document.querySelectorAll('tbody tr[data-slot=table-row]');
        cache.rev = Data.rev;
        cache.scroller = null;
        cache.head = null;
        cache.lastIndex = 0;
      }

      if (!cache.rows.length) return cache;

      if (!cache.scroller || !cache.scroller.isConnected) {
        let node = cache.rows[0].parentElement;
        while (node && node !== document.body) {
          const style = getComputedStyle(node);
          if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) {
            cache.scroller = node;
            break;
          }
          node = node.parentElement;
        }
        cache.head = null;
      }

      if (!cache.head || !cache.head.isConnected) {
        const edge = cache.scroller ? cache.scroller.getBoundingClientRect().top : 0;
        const heads = document.querySelectorAll('thead');
        for (let i = 0; i < heads.length; i += 1) {
          const box = heads[i].getBoundingClientRect();
          // 只有压住可视区顶部的那条表头才参与计算，远处的表头不算
          if (box.height > 0 && box.bottom > edge && box.bottom < edge + 400) {
            cache.head = heads[i];
            break;
          }
        }
      }

      return cache;
    },

    /** 可视顶边：滚动容器顶边，再让开贴在顶部的那条 sticky 表头 */
    visibleTop(cache) {
      let edge = cache.scroller ? cache.scroller.getBoundingClientRect().top : 0;
      if (cache.head && cache.head.isConnected) {
        const box = cache.head.getBoundingClientRect();
        if (box.height > 0 && box.bottom > edge && box.bottom < edge + 400) edge = box.bottom;
      }
      return edge;
    },

    /** 可视底边：滚动容器底边与窗口高度取小 */
    visibleBottom(cache) {
      const edge = cache.scroller ? cache.scroller.getBoundingClientRect().bottom : window.innerHeight;
      return Math.min(edge > 0 ? edge : window.innerHeight, window.innerHeight);
    },

    /** 行 → 商品 id：缩略图背景图里带 id；取不到再按行序兜底 */
    rowId(row) {
      const cell = row.children[1];
      const box = cell ? cell.querySelector('div[style*="background-image"]') : null;
      const matched = box ? String(box.style.backgroundImage || '').match(/tiktok\.product\/(\d+)/) : null;
      if (matched) return matched[1];

      const siblings = row.parentElement ? row.parentElement.children : null;
      const index = siblings ? Array.prototype.indexOf.call(siblings, row) : -1;
      return index >= 0 && Data.items[index] ? Data.items[index].id : '';
    },

    /** 找到页面当前可见的第一行，把对应卡片贴到列表顶部并标记 */
    align() {
      if (Store.state.view !== 'show') return;
      const list = ListView.listEl();
      if (!list) return;

      const cache = this.nodes();
      const rows = cache.rows;
      if (!rows.length) return;

      const top = this.visibleTop(cache);
      const bottom = this.visibleBottom(cache);

      /*
       * 行位置随滚动单调递增：二分找到第一个 bottom > 顶边的行（51 行约 6 次 rect），
       * 再从该行往下取第一个露出 ≥75% 的行。
       */
      let lo = 0;
      let hi = rows.length - 1;
      let start = rows.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const box = rows[mid].getBoundingClientRect();
        if (box.bottom > top + 1) { start = mid; hi = mid - 1; } else lo = mid + 1;
      }
      if (start >= rows.length) return;

      const pick = (from, to) => {
        for (let i = from; i < to; i += 1) {
          const box = rows[i].getBoundingClientRect();
          if (box.bottom <= top || box.top >= bottom) continue;   // 整行都在视口外
          const shown = Math.min(box.bottom, bottom) - Math.max(box.top, top);
          if (shown >= (box.bottom - box.top) * this.VISIBLE_RATIO) return i;
        }
        return -1;
      };

      let index = pick(start, rows.length);
      if (index < 0) index = start;   // 没有一行露出 75%（行特别矮时）就取第一可见行
      cache.lastIndex = index;

      const id = this.rowId(rows[index]);
      if (!id) return;

      const card = list.querySelector('[data-card="' + Util.esc(id) + '"]');
      if (!card) return;

      const delta = card.getBoundingClientRect().top - list.getBoundingClientRect().top;
      if (Math.abs(delta) > 2) list.scrollTop += delta;

      // 只保留一个高亮：先摘旧的再挂新的，避免滚动过程中累积多个
      const prev = list.querySelector('.sp-card.cur');
      if (prev && prev !== card) prev.classList.remove('cur');
      card.classList.add('cur');
    }
  };

  /* ---------- §11.5 导出（点选 / 单条 + 写文件） ---------- */

  const Exporter = {
    selected: new Set(),
    busy: false,

    toggle(id, on) {
      if (on) this.selected.add(id);
      else this.selected.delete(id);

      const card = View.refs.content
        ? View.refs.content.querySelector('[data-card="' + Util.esc(id) + '"]')
        : null;
      if (card) card.classList.toggle('on', on);
      ListView.paintCount();
    },

    /** 全选 / 全不选：只改勾选，不动列表结构 */
    pickAll(on) {
      this.selected.clear();
      if (on) Data.items.forEach((item) => this.selected.add(item.id));

      const list = ListView.listEl();
      if (list) {
        const cards = list.querySelectorAll('[data-card]');
        for (let i = 0; i < cards.length; i += 1) cards[i].classList.toggle('on', on);
      }
      ListView.paintCount();
    },

    /** 按钮忙闲：文案带翻译进度，避免重复点击 */
    setBusy(busy, done, total) {
      this.busy = busy;
      const box = View.refs.content;
      const btn = box && box.querySelector('[data-sp="export"]');
      if (!btn) return;
      btn.disabled = busy;
      btn.textContent = busy
        ? (total ? '翻译 ' + done + '/' + total : '导出中…')
        : '导出 Excel';
    },

    /**
     * 主流程：定商品集（勾选 → 全部）→ 补翻译 → 补类目名 → 组装 → 下载。
     * only 传了数组就只导这几条，供控制台调用。
     */
    async run(only) {
      if (this.busy) return;
      if (!Data.items.length) {
        View.toast('没有读到商品行，先点「重新读取」');
        return;
      }

      let items;
      if (Array.isArray(only) && only.length) {
        items = only.slice();
      } else if (this.selected.size) {
        items = Data.items.filter((item) => this.selected.has(item.id));
      } else {
        items = Data.items.slice();
      }
      if (!items.length) {
        View.toast('勾选项已失效，请重新勾选');
        return;
      }

      this.setBusy(true, 0, 0);
      try {
        await Trans.ensure(items, (done, total) => this.setBusy(true, done, total), true);
        await Data.ensureCategory(items);

        const sheet = Sheet.build(items);
        Xlsx.download(Xlsx.build(sheet), Xlsx.filename());

        const translated = items.filter((item) => item.translation).length;
        View.toast('已导出 ' + items.length + ' 行 × ' + sheet.headers.length +
          ' 列（翻译 ' + translated + '/' + items.length + '）');
        ListView.paintText();
      } catch (e) {
        View.toast('导出失败：' + (e && e.message ? e.message : e));
      } finally {
        this.setBusy(false);
      }
    }
  };

  /* ---------- §11.6 设置界面 ---------- */

  const Settings = {
    /** 只留扩展列开关；列宽 / 行高按 Python 版式固定，不给入口 */
    render() {
      if (!View.mounted || !View.refs.settings) return;

      const tags = ExCfg.toggleCols().map((col) => [
        '<button class="tag' + (ExCfg.isOn(col.key) ? ' on' : '') + '"',
        ' data-excol="' + col.key + '" title="' + Util.esc(col.header) + '">',
        Util.esc(col.header) + '</button>'
      ].join('')).join('');

      View.refs.settings.innerHTML = [
        '<div class="tags">' + tags + '</div>',
        '<div class="note">最前三个是前置列（搜索词只在页面有搜索时才出现）；标蓝的列都会进导出表。</div>'
      ].join('');
    },

    /** 网页优化开关：点标签切换，关闭即回到站点原本行为 */
    renderWeb() {
      const box = View.refs.webopt;
      if (!View.mounted || !box) return;

      const tags = WebOpt.ITEMS.map((item) => [
        '<button class="tag' + (WebOpt.isOn(item.key) ? ' on' : '') + '"',
        ' data-web="' + item.key + '" title="' + Util.esc(item.hint) + '">',
        Util.esc(item.label) + '</button>'
      ].join('')).join('');

      box.innerHTML = [
        '<div class="tags">' + tags + '</div>',
        '<div class="note">点一下切换，关掉即恢复站点原本行为，开关即时生效不用刷新。</div>'
      ].join('');
    },

    /** 网页优化项被点击：先落盘再决定要不要重绘 */
    toggleWeb(key) {
      if (!key) return;
      WebOpt.set(key, !WebOpt.isOn(key));
      this.renderWeb();

      if (key === 'thumbBg') ListView.paintList();
    }
  };

  /* ---------- §11.7 控件调度（所有点击 / 变更的唯一入口） ---------- */

  const ShowUI = {
    tipTimer: 0,

    onClick(node) {
      const action = node.getAttribute('data-sp');
      if (action === 'export') Exporter.run();
      else if (action === 'reload') Show.refresh();
      else if (action === 'pick-all') this.pickAll();
      else if (action === 'mark-add') this.addMark(this.markInputValue());
      else if (action === 'mark-del') this.removeMark(node.getAttribute('data-mark') || '');
      else if (action === 'mark-pick') this.pickByMark(node.getAttribute('data-mark') || '');
      else if (action === 'mark-clear') this.clearAll();
    },

    /** 扩展列开关：标签点一下切换，落盘后只改这一个标签的样式 */
    toggleExtra(node) {
      const key = node.getAttribute('data-excol') || '';
      if (!key) return;

      const on = !ExCfg.isOn(key);
      ExCfg.setExtra(key, on);
      node.classList.toggle('on', on);

      const col = ExCfg.toggleCols().filter((c) => c.key === key)[0];
      node.setAttribute('title', (col ? col.header : key) +
        (on ? '：已加入导出' : '：未加入导出'));
    },

    /**
     * 关键词框：一边输入一边高亮（蓝色），不过滤列表 —— 列表必须与页面行一一对应。
     * 回车 / 点「存」后词条转成词库里的黄色高亮。
     */
    onSearch(value) {
      Hit.keyword = String(value || '');
      ListView.paintText();

      const list = ListView.listEl();
      if (!list || !Hit.keyword.trim()) return;
      const first = list.querySelector('mark.sp-hit.search');
      const card = first ? first.closest('.sp-card') : null;
      if (!card) return;
      const delta = card.getBoundingClientRect().top - list.getBoundingClientRect().top;
      if (delta < 0 || delta > list.clientHeight - 40) list.scrollTop += delta;
    },

    markInputValue() {
      const input = View.refs.content ? View.refs.content.querySelector('input[data-ref="spSearch"]') : null;
      return input ? input.value : '';
    },

    /** 存入词库：输入框清空 → 蓝色临时高亮变成黄色常驻高亮 */
    addMark(text) {
      const value = String(text == null ? '' : text).trim();
      if (!value) {
        View.toast('先输入一个关键词');
        return;
      }

      if (!Marks.add(value)) {
        View.toast('「' + value + '」已经在词库里');
        return;
      }

      const input = View.refs.content ? View.refs.content.querySelector('input[data-ref="spSearch"]') : null;
      if (input) input.value = '';
      Hit.keyword = '';

      ListView.paintMarks();
      ListView.paintText();
    },

    removeMark(text) {
      if (!Marks.remove(text)) return;
      ListView.paintMarks();
      ListView.paintText();
    },

    /**
     * 词条一键勾选：包含该词的商品整批进出「已选」。
     * 两段式：该词匹配到的商品已全部选中时整批取消，否则整批勾上。
     */
    pickByMark(text) {
      const key = String(text || '').trim().toLowerCase();
      if (!key) return;

      const matched = Data.items.filter((item) =>
        (item.title + ' ' + (item.translation || '')).toLowerCase().indexOf(key) !== -1);
      if (!matched.length) {
        View.toast('没有包含「' + text + '」的商品');
        return;
      }

      const allOn = matched.every((item) => Exporter.selected.has(item.id));
      const list = ListView.listEl();

      matched.forEach((item) => {
        if (allOn) Exporter.selected.delete(item.id);
        else Exporter.selected.add(item.id);
        const card = list && list.querySelector('[data-card="' + Util.esc(item.id) + '"]');
        if (card) card.classList.toggle('on', Exporter.selected.has(item.id));
      });

      ListView.paintMarks();
      ListView.paintCount();
      View.toast((allOn ? '已取消 ' : '已勾选 ') + matched.length + ' 件（含「' + text + '」）');
    },

    /** 一键清除：输入框 + 已保存的词一起清空 */
    clearAll() {
      const had = Marks.list.length;
      Marks.clear();
      Hit.keyword = '';

      const input = View.refs.content ? View.refs.content.querySelector('input[data-ref="spSearch"]') : null;
      if (input) input.value = '';

      ListView.hideTip();
      ListView.paintMarks();
      ListView.paintText();
      View.toast(had ? '已清除输入框与 ' + had + ' 个高亮词' : '已清空输入框');
    },

    pickAll() {
      const allPicked = Data.items.length > 0 && Exporter.selected.size === Data.items.length;
      Exporter.pickAll(!allPicked);
    },

    /* ---------- 商品卡：点选 / 悬停浮窗 ---------- */

    /**
     * 点中文名只做复制，不改勾选状态；点外文名 / 图片 / 其它空白处仍是勾选。
     */
    onCardClick(card, event) {
      const id = card.getAttribute('data-card') || '';
      if (!id) return;

      const cn = event && event.target && event.target.closest ? event.target.closest('.sp-cn') : null;
      if (cn) {
        const item = ListView.byId(id);
        this.copyText(cn.textContent || (item ? ListView.textOf(item) : ''));
        return;
      }
      Exporter.toggle(id, !Exporter.selected.has(id));
    },

    /** 复制文本：优先进剪贴板 API，被权限拦下就走 textarea 兜底 */
    copyText(text) {
      const value = String(text == null ? '' : text).trim();
      if (!value) {
        View.toast('这条还没有中文名可复制');
        return;
      }
      const done = () => View.toast('已复制：' + (value.length > 16 ? value.slice(0, 16) + '…' : value));

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, () => this.copyFallback(value, done));
        return;
      }
      this.copyFallback(value, done);
    },

    copyFallback(value, done) {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch (e) { /* 无剪贴板权限时静默失败 */ }
      document.body.removeChild(area);
      done();
    },

    onCardHover(card) {
      this.keepTip();
      ListView.showTip(card);
    },

    /** 指针离开卡片：留一点余量再收浮窗，避免在卡片缝隙间来回闪 */
    onCardLeave() {
      if (this.tipTimer) clearTimeout(this.tipTimer);
      this.tipTimer = setTimeout(() => {
        this.tipTimer = 0;
        ListView.hideTip();
      }, 220);
    },

    keepTip() {
      if (this.tipTimer) clearTimeout(this.tipTimer);
      this.tipTimer = 0;
    },

    hideTip() {
      this.keepTip();
      ListView.hideTip();
    }
  };

  /* ---------- §11.8 对外入口 ---------- */

  const Show = {
    render() {
      this.reload(true);
    },

    /** 重新读页面缓存并重绘；silent = 不弹「没读到」提示 */
    reload(silent) {
      Data.read();
      Live.sync();
      ListView.render();
      Sync.bind();
      Sync.schedule();          // 重绘后重新贴合页面当前首行
      this.translate();
      if (!silent && !Data.items.length) {
        View.toast('未读到商品行，请确认页面在商品榜视图');
      }
    },

    refresh() {
      this.reload(false);
      View.toast('已重新读取 ' + Data.items.length + ' 行');
    },

    /** 面板比表格先挂载时补读几次（一次性定时器，读到即止，不常驻） */
    autoFill() {
      EX.FILL_WAIT.forEach((ms) => setTimeout(() => {
        if (!Data.items.length && View.mounted) this.reload(true);
      }, ms));
    },

    /** 缓存命中的立刻显示，缺的按并发上限补；每几个回来刷新一次文字 */
    translate() {
      const items = Data.items;
      if (!items.length) return;

      const missing = items.some((item) => !item.translation && !Trans.get(item.title));
      if (!missing) {
        items.forEach((item) => { item.translation = item.translation || Trans.get(item.title) || ''; });
        ListView.paintText();
        return;
      }

      let tick = 0;
      Trans.ensure(items, () => {
        tick += 1;
        if (tick % 3 === 0) ListView.paintText();
      }).then(() => {
        ListView.paintText();
        Sync.schedule();
      }).catch(() => {});
    }
  };

  /* 偏好先读回来，再启动：面板一挂载就是用户上次的样子 */
  ExCfg.load();
  Marks.load();
  WebOpt.load();
  WebOpt.applyNetwork();
  Live.install();

  App.init();
})();
